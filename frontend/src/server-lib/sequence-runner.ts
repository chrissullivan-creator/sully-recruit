/**
 * Engine-neutral sequence runner. Houses the action-execution body and
 * downstream helpers (mark, advance, complete, stop, sentiment, re-anchor)
 * so both engines call into the same code:
 *
 *   - Trigger.dev `sequenceActionExecute` task → wraps `runSequenceAction`
 *   - Inngest `sequence-action-execute` function → wraps `runSequenceAction`
 *
 * Lives under `src/server-lib/` for proximity to the only callers we have
 * today (and to share the channel/merge-tag/send-time helpers in the same
 * directory). Nothing in this file imports the Trigger.dev SDK directly —
 * callers pass a logger that satisfies the small `Logger` interface below.
 *
 * The `Logger` shape matches both Trigger.dev's `logger` from
 * `@trigger.dev/sdk/v3` and Inngest's per-run logger, so each engine can
 * pass its own without an adapter.
 */
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./send-channels.js";
import { resolveMergeTags, applyMergeTags, formatEmailBody, validateEmail } from "./merge-tags.js";
import { calculateSendTime, incrementDailySend, localDateString } from "./send-time-calculator.js";
import { canonicalChannel } from "./unipile-v2.js";
import { notifyError } from "./alerting.js";

export interface Logger {
  info: (msg: string, meta?: any) => void;
  warn: (msg: string, meta?: any) => void;
  error: (msg: string, meta?: any) => void;
}

export interface ActionExecutePayload {
  stepLogId: string;
  enrollmentId: string;
  actionId: string;
  nodeId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action execution — body of what was sequenceActionExecute.run
// ─────────────────────────────────────────────────────────────────────────────

export async function runSequenceAction(
  supabase: any,
  payload: ActionExecutePayload,
  logger: Logger,
): Promise<{ action: string; reason?: string; channel?: string; retryAt?: string }> {
  // Idempotency: only proceed if the step_log is still claimed
  // ('in_flight'). The sweep claims via UPDATE WHERE status='scheduled',
  // so there's exactly one path that sets it to in_flight per row. If
  // we see anything else here, another execution already finished this
  // log and the engine re-invoked us on retry. Bailing protects against
  // the post-send-throws-then-retry double-send.
  const { data: stepLog } = await supabase
    .from("sequence_step_logs")
    .select("status")
    .eq("id", payload.stepLogId)
    .maybeSingle();

  if (!stepLog || stepLog.status !== "in_flight") {
    return { action: "skipped", reason: `step_log_status_${stepLog?.status || "missing"}` };
  }

  // Re-validate enrollment + parent sequence are both still active.
  // Pausing a sequence (or stopping the enrollment) needs to halt
  // sends on logs that were already claimed but not yet executed.
  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq("id", payload.enrollmentId)
    .single();

  if (!enrollment || enrollment.status !== "active") {
    await markStepLog(supabase, payload.stepLogId, "cancelled");
    return { action: "cancelled", reason: "enrollment_not_active" };
  }

  if (enrollment.sequences?.status !== "active") {
    await markStepLog(supabase, payload.stepLogId, "cancelled");
    return { action: "cancelled", reason: `sequence_status_${enrollment.sequences?.status}` };
  }

  // Reply guard — any reply except connection acceptance stops everything
  const hasReply = await hasRepliedSinceEnrollment(supabase, enrollment);
  if (hasReply) {
    await stopEnrollment(supabase, enrollment, "reply_received", undefined, logger);
    await markStepLog(supabase, payload.stepLogId, "cancelled");
    return { action: "stopped", reason: "reply_received" };
  }

  // Fetch action definition
  const { data: action } = await supabase
    .from("sequence_actions")
    .select("*")
    .eq("id", payload.actionId)
    .single();

  if (!action) {
    await markStepLog(supabase, payload.stepLogId, "failed");
    return { action: "error", reason: "action_not_found" };
  }

  const sequence = enrollment.sequences;
  // Per-step sender override (PR #234) takes priority over the
  // sequence-level sender. Falls back to sequence.sender_user_id, then
  // sequence.created_by, then the enroller — so existing sequences
  // without overrides keep their current behaviour.
  const senderUserId =
    action.sender_user_id ||
    sequence.sender_user_id ||
    sequence.created_by ||
    payload.enrolledBy;
  const entityId = payload.candidateId || payload.contactId;
  const entityType = payload.candidateId ? "candidate" : "contact";

  if (!entityId) {
    await markStepLog(supabase, payload.stepLogId, "failed");
    return { action: "error", reason: "no_entity_id" };
  }

  // Manual call → just log it
  if (action.channel === "manual_call") {
    await markStepLog(supabase, payload.stepLogId, "sent", new Date());
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "manual_call_logged" };
  }

  // Pre-flight: check recipient has required contact info.
  // Both candidate_id and contact_id reference the unified `people` table
  // (`candidates` / `contacts` are now views over it).
  //
  // Email column choice depends on the person's role:
  //   - candidates → personal_email (their personal address; work emails
  //     leak via corporate filters and tip off the candidate's employer)
  //   - clients    → work_email (we engage with them in their pro context)
  // The legacy `primary_email` column is the fallback during the migration.
  const { data: entityRow } = await supabase
    .from("people")
    .select("type, primary_email, work_email, personal_email, phone, linkedin_url, email_invalid, do_not_contact")
    .eq("id", entityId)
    .maybeSingle();

  // Compliance guard — a person flagged do_not_contact (e.g. they replied
  // "stop") must not receive anything, even on a step that was already
  // scheduled before they opted out. Stop the whole enrollment.
  if (entityRow?.do_not_contact) {
    await stopEnrollment(supabase, enrollment, "do_not_contact", undefined, logger);
    await markStepLog(supabase, payload.stepLogId, "cancelled");
    return { action: "stopped", reason: "do_not_contact" };
  }

  const resolvedEmail =
    entityRow?.type === "candidate"
      ? (entityRow?.personal_email || entityRow?.primary_email || "")
      : (entityRow?.work_email || entityRow?.primary_email || "");

  if (action.channel === "email" && !resolvedEmail) {
    await markStepSkipped(supabase, payload.stepLogId, "no_email_on_record");
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "skipped", reason: "no_email_on_record" };
  }
  if (action.channel === "email" && entityRow?.email_invalid) {
    // Hard-bounced previously — don't re-attempt.
    await markStepSkipped(supabase, payload.stepLogId, "email_invalid_bounced");
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "skipped", reason: "email_invalid_bounced" };
  }
  if (action.channel === "sms" && !entityRow?.phone) {
    await markStepSkipped(supabase, payload.stepLogId, "no_phone_on_record");
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "skipped", reason: "no_phone_on_record" };
  }
  if (action.channel.startsWith("linkedin") && !entityRow?.linkedin_url) {
    await markStepSkipped(supabase, payload.stepLogId, "no_linkedin_url");
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "skipped", reason: "no_linkedin_url" };
  }

  // Resolve merge tags
  const mergeVars = await resolveMergeTags(supabase, entityId, entityType);
  mergeVars.sender_name = await getSenderName(supabase, senderUserId);
  if (sequence.job_id) {
    const { data: job } = await supabase.from("jobs").select("title").eq("id", sequence.job_id).maybeSingle();
    mergeVars.job_name = job?.title || "";
  }

  const messageBody = applyMergeTags(action.message_body, mergeVars);

  // Resolve recipient
  let to: string;
  let conversationId: string | null;
  try {
    const resolved = await resolveRecipient(
      supabase,
      action.channel === "linkedin_inmail" ? "linkedin_message" : action.channel,
      entityId,
      entityType,
      senderUserId,
      payload.accountId,
    );
    to = resolved.to;
    conversationId = resolved.conversationId;
  } catch (err: any) {
    await markStepSkipped(supabase, payload.stepLogId, `resolve_failed: ${err.message}`);
    await checkSequenceComplete(supabase, enrollment, logger);
    return { action: "skipped", reason: err.message };
  }

  // Send
  let sendResult: any;
  try {
    switch (action.channel) {
      case "email": {
        const emailValidation = validateEmail(to);
        if (!emailValidation.valid) {
          await markStepSkipped(supabase, payload.stepLogId, `invalid_email_${emailValidation.reason}`);
          await checkSequenceComplete(supabase, enrollment, logger);
          return { action: "skipped", reason: `invalid_email` };
        }

        // Threading: when this step is flagged reply_to_previous, look
        // up the most recent SENT email step log in this enrollment and
        // pull its captured internet_message_id. Outlook/Gmail render
        // the resulting email as a threaded reply to that one.
        let subject = action.subject_line || "";
        let threadingOptions: { inReplyTo?: string; references?: string } | undefined;
        if (action.reply_to_previous) {
          const { data: prev } = await supabase
            .from("sequence_step_logs")
            .select("internet_message_id, action_id, sent_at")
            .eq("enrollment_id", payload.enrollmentId)
            .eq("status", "sent")
            .eq("channel", "email")
            .not("internet_message_id", "is", null)
            .order("sent_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (prev?.internet_message_id) {
            threadingOptions = {
              inReplyTo: prev.internet_message_id,
              references: prev.internet_message_id,
            };
            // Re-use the previous step's subject (with "Re: " prefix)
            // when the user didn't type a fresh one.
            if (!subject) {
              const { data: prevAction } = await supabase
                .from("sequence_actions")
                .select("subject_line")
                .eq("id", prev.action_id)
                .maybeSingle();
              const prevSubject = prevAction?.subject_line || "";
              subject = prevSubject ? (prevSubject.startsWith("Re:") ? prevSubject : `Re: ${prevSubject}`) : "";
            }
          }
        }

        // attachment_urls is the canonical multi-file list; fall
        // back to the legacy single attachment_url for older rows.
        const emailAttachments: string[] | undefined =
          Array.isArray(action.attachment_urls) && action.attachment_urls.length
            ? action.attachment_urls
            : (action.attachment_url ? [action.attachment_url] : undefined);
        sendResult = await sendEmail(
          supabase, to, subject || undefined, formatEmailBody(messageBody), senderUserId,
          threadingOptions, action.use_signature !== false, payload.stepLogId,
          emailAttachments,
        );
        break;
      }
      case "sms":
        sendResult = await sendSms(supabase, to, messageBody, senderUserId);
        break;
      case "linkedin_connection":
        // Connection requests don't carry attachments (no file field
        // on Unipile's invite endpoint), so attachmentUrl is omitted.
        sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_connection");
        break;
      case "linkedin_message": {
        const liAttachments: string[] | undefined =
          Array.isArray(action.attachment_urls) && action.attachment_urls.length
            ? action.attachment_urls
            : (action.attachment_url ? [action.attachment_url] : undefined);
        sendResult = await sendLinkedIn(
          supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_message",
          liAttachments,
        );
        break;
      }
      case "linkedin_inmail": {
        const inmailAttachments: string[] | undefined =
          Array.isArray(action.attachment_urls) && action.attachment_urls.length
            ? action.attachment_urls
            : (action.attachment_url ? [action.attachment_url] : undefined);
        sendResult = await sendLinkedIn(
          supabase, to, messageBody, senderUserId, payload.accountId, "recruiter_inmail",
          inmailAttachments,
          action.subject_line || undefined,
        );
        break;
      }
      default:
        await markStepLog(supabase, payload.stepLogId, "failed");
        return { action: "failed", reason: `unsupported_channel` };
    }
  } catch (err: any) {
    const errMsg = err.message || "";
    const errLower = errMsg.toLowerCase();

    // Provider-side rate limit signal — reschedule +2h.
    const isRateLimit =
      errLower.includes("limit_exceeded") ||
      errLower.includes("rate limit") ||
      errLower.includes("429") ||
      errLower.includes("too many requests");

    // Transient infra failure — Supabase pause, DB connection blip,
    // Unipile API timeout, missing app_settings on a stale fetch.
    // Treating these as transient and rescheduling +30 min so the
    // next sweep retries.
    const isTransient =
      errLower.includes("fetch failed") ||
      errLower.includes("network") ||
      errLower.includes("econnreset") ||
      errLower.includes("timed out") ||
      errLower.includes("timeout") ||
      errLower.includes("unipile config missing") ||
      errLower.includes("unipile api unreachable") ||
      errLower.includes("could not resolve linkedin profile") && errLower.includes("timeout");

    if (isRateLimit && action.channel.startsWith("linkedin")) {
      // Push the step back by 2 hours instead of failing it
      const retryAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("sequence_step_logs")
        .update({ scheduled_at: retryAt, status: "scheduled" } as any)
        .eq("id", payload.stepLogId);
      logger.warn("LinkedIn rate limit hit — rescheduling step in 2h", {
        channel: action.channel,
        enrollmentId: payload.enrollmentId,
        retryAt,
      });
      return { action: "rate_limited", reason: errMsg, retryAt };
    }

    if (isTransient) {
      const retryAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await supabase
        .from("sequence_step_logs")
        .update({ scheduled_at: retryAt, status: "scheduled" } as any)
        .eq("id", payload.stepLogId);
      logger.warn("Transient send error — rescheduling step in 30 min", {
        channel: action.channel,
        enrollmentId: payload.enrollmentId,
        err: errMsg,
        retryAt,
      });
      return { action: "transient_retry", reason: errMsg, retryAt };
    }

    logger.error("Send failed", { channel: action.channel, error: errMsg });
    await markStepLog(supabase, payload.stepLogId, "failed");
    return { action: "failed", reason: errMsg };
  }

  // Mark sent. For email sends we also persist the
  // internet_message_id Graph returns so the next email step in this
  // enrollment can thread as a reply.
  const sentAt = new Date();
  await markStepLog(supabase, payload.stepLogId, "sent", sentAt);
  if (action.channel === "email" && (sendResult as any)?.internetMessageId) {
    await supabase
      .from("sequence_step_logs")
      .update({ internet_message_id: (sendResult as any).internetMessageId } as any)
      .eq("id", payload.stepLogId);
  }

  // Re-anchor the next pending step to actual sent_at + delay.
  await reanchorNextStep(supabase, payload.enrollmentId, payload.stepLogId, sentAt, sequence, logger);

  // Increment daily send counter, keyed by the sequence's local date so the
  // counter aligns with the cap check (checkDailyCap uses the same zone).
  const dateStr = localDateString(sentAt, sequence.timezone || undefined);
  await incrementDailySend(supabase, senderUserId, action.channel, dateStr);

  // Log outbound message. Canonicalise channel so sequence sends
  // share buckets with inbound replies (linkedin_inmail →
  // linkedin_recruiter, linkedin_message/connection → linkedin) —
  // otherwise threads would split across two channel values.
  const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
  await supabase.from("messages").insert({
    [entityColumn]: entityId,
    conversation_id: conversationId || `seq_${payload.enrollmentId}`,
    channel: canonicalChannel(action.channel),
    direction: "outbound",
    body: messageBody,
    sent_at: sentAt.toISOString(),
    provider: action.channel.startsWith("linkedin") ? "unipile" : action.channel === "email" ? "microsoft_graph" : "ringcentral",
    external_message_id: sendResult?.messageId || sendResult?.message_id || sendResult?.id,
    owner_id: senderUserId,
  } as any);

  logger.info("Action sent", { channel: action.channel, enrollmentId: payload.enrollmentId, entityId });

  // Check if all actions are now done → mark complete
  await checkSequenceComplete(supabase, enrollment, logger);

  return { action: "sent", channel: action.channel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — exported so both engines can call them directly. The Trigger.dev
// `pendingConnectionTimeout` task uses `advanceCurrentNode` and
// `checkSequenceComplete`; the per-engine wiring code in `sequence-scheduler.ts`
// (Trigger.dev) and the Inngest sweep both use `stopEnrollment` / `markStepLog`.
// ─────────────────────────────────────────────────────────────────────────────

/** Check if ALL actions for this enrollment are done (sent/failed/skipped/cancelled).
 *  If none are pending or pending_connection, mark enrollment as completed. */
export async function checkSequenceComplete(supabase: any, enrollment: any, logger: Logger): Promise<void> {
  const { count } = await supabase
    .from("sequence_step_logs")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", enrollment.id)
    .in("status", ["scheduled", "pending_connection"]);

  if ((count || 0) === 0) {
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed", stop_trigger: "completed", stopped_at: new Date().toISOString() })
      .eq("id", enrollment.id);
    logger.info("Enrollment completed — all actions done", { enrollmentId: enrollment.id });
  }
}

export async function hasRepliedSinceEnrollment(supabase: any, enrollment: any): Promise<boolean> {
  const entityColumn = enrollment.candidate_id ? "candidate_id" : "contact_id";
  const entityId = enrollment.candidate_id || enrollment.contact_id;

  const { data: replies } = await supabase
    .from("messages")
    .select("id")
    .eq(entityColumn, entityId)
    .eq("direction", "inbound")
    .neq("message_type", "connection_accepted")
    .gte("sent_at", enrollment.enrolled_at)
    .limit(1);

  return replies !== null && replies.length > 0;
}

export async function stopEnrollment(
  supabase: any,
  enrollment: any,
  trigger: string,
  replyText?: string,
  logger?: Logger,
): Promise<void> {
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "stopped",
      stop_trigger: trigger,
      stop_reason: trigger,
      stopped_at: new Date().toISOString(),
    })
    .eq("id", enrollment.id);

  // Cancel ALL pending sends (scheduled + pending_connection)
  await supabase
    .from("sequence_step_logs")
    .update({ status: "cancelled" })
    .eq("enrollment_id", enrollment.id)
    .in("status", ["scheduled", "pending_connection"]);

  logger?.info("Enrollment stopped", { enrollmentId: enrollment.id, trigger });

  if (replyText && trigger === "reply_received") {
    await triggerSentimentAnalysis(supabase, enrollment, replyText, logger);
  }
}

/**
 * Stamp WHICH sent step earned the reply, so the analytics funnels can
 * attribute it (per-step + per-channel reply rates).
 *
 * Note: reply *sentiment* and recruiting-intel extraction already run at the
 * webhook layer (intel-extraction → `reply_sentiment` table +
 * `sequence_enrollments.reply_sentiment` + `last_sequence_sentiment`) BEFORE
 * the enrollment is stopped — so there is no AI call to make here. An earlier
 * version POSTed to a `sentiment_analysis` task on `ask-joe` that was never
 * implemented (and `ask-joe` streams SSE, so `response.json()` threw on every
 * reply), which meant `reply_received_at` was never actually stamped. This
 * does the one thing that was still missing, with no external dependency.
 */
export async function triggerSentimentAnalysis(
  supabase: any,
  enrollment: any,
  replyText: string,
  logger?: Logger,
): Promise<void> {
  try {
    const { data: lastSent } = await supabase
      .from("sequence_step_logs")
      .select("id")
      .eq("enrollment_id", enrollment.id)
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastSent?.id) {
      await supabase
        .from("sequence_step_logs")
        .update({ reply_received_at: new Date().toISOString(), reply_text: replyText.slice(0, 2000) })
        .eq("id", lastSent.id);
    }
  } catch (err: any) {
    logger?.error("Failed to stamp reply on last sent step", {
      error: err.message,
      enrollmentId: enrollment?.id,
    });
    await notifyError({
      taskId: "sequence-runner.stampReply",
      severity: "WARN",
      error: err,
      context: { enrollmentId: enrollment?.id },
    });
  }
}

export async function getSenderName(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();
  return profile?.full_name || `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "";
}

/**
 * After a step actually sends, push the next pending step's
 * scheduled_at to actualSentAt + that step's delay (respecting send
 * window + caps via calculateSendTime). Without this, a step that
 * was delayed by daily cap or rate-limit retry leaks an unintended
 * shorter gap to the next step.
 */
export async function reanchorNextStep(
  supabase: any,
  enrollmentId: string,
  currentStepLogId: string,
  actualSentAt: Date,
  sequence: any,
  logger: Logger,
): Promise<void> {
  const { data: nextLog } = await supabase
    .from("sequence_step_logs")
    .select("id, scheduled_at, sequence_actions!inner(*)")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "scheduled")
    .neq("id", currentStepLogId)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextLog) return;

  const action = (nextLog as any).sequence_actions;
  if (!action) {
    // Step row exists but its sequence_actions row vanished — usually a
    // sequence edit while an enrollment is mid-flight. Silent return
    // would leave the next step at its original scheduled_at and fire
    // too early. Surface it so we can decide whether to repair the
    // step or stop the enrollment.
    await notifyError({
      taskId: "sequence-runner.reanchorNextStep",
      severity: "WARN",
      error: new Error(`Next step has no sequence_actions row (deleted mid-flight?)`),
      context: { enrollmentId, currentStepLogId, nextStepLogId: (nextLog as any).id },
    });
    return;
  }

  // Honour per-step sender override here too, otherwise re-anchored
  // steps fall back to the sequence-level account when computing the
  // next send window / daily cap.
  const senderUserId = action.sender_user_id || sequence.sender_user_id || sequence.created_by;
  const newScheduledAt = await calculateSendTime(supabase, {
    startTime: actualSentAt,
    delayHours: Number(action.base_delay_hours) || 0,
    delayMinutes: action.delay_interval_minutes || 0,
    jiggleMinutes: action.jiggle_minutes || 0,
    channel: action.channel,
    sendWindowStart: sequence.send_window_start || "09:00",
    sendWindowEnd: sequence.send_window_end || "18:00",
    accountId: senderUserId,
    timezone: sequence.timezone || undefined,
    weekdaysOnly: sequence.weekdays_only === true,
  });

  // Push-back only — never pull a step earlier (would surprise the recipient).
  const existing = new Date(nextLog.scheduled_at);
  if (newScheduledAt.getTime() <= existing.getTime()) return;

  await supabase
    .from("sequence_step_logs")
    .update({ scheduled_at: newScheduledAt.toISOString(), updated_at: new Date().toISOString() } as any)
    .eq("id", nextLog.id);

  logger.info("Re-anchored next step to actual send time", {
    enrollmentId,
    nextStepLogId: nextLog.id,
    delta_minutes: Math.round((newScheduledAt.getTime() - existing.getTime()) / 60000),
  });
}

export async function markStepLog(supabase: any, stepLogId: string, status: string, sentAt?: Date): Promise<void> {
  const update: any = { status };
  if (sentAt) update.sent_at = sentAt.toISOString();
  await supabase.from("sequence_step_logs").update(update).eq("id", stepLogId);
  await advanceCurrentNode(supabase, stepLogId);
}

export async function markStepSkipped(supabase: any, stepLogId: string, reason: string): Promise<void> {
  await supabase.from("sequence_step_logs").update({ status: "skipped", skip_reason: reason } as any).eq("id", stepLogId);
  await advanceCurrentNode(supabase, stepLogId);
}

/**
 * Move the enrollment's `current_node_id` forward to the next not-yet-fired
 * step (scheduled / in_flight / pending_connection), so the UI can show
 * accurate progress like "step 3 of 5".
 */
export async function advanceCurrentNode(supabase: any, stepLogId: string): Promise<void> {
  const { data: log } = await supabase
    .from("sequence_step_logs")
    .select("enrollment_id")
    .eq("id", stepLogId)
    .maybeSingle();
  if (!log?.enrollment_id) return;

  const { data: nextLog } = await supabase
    .from("sequence_step_logs")
    .select("node_id")
    .eq("enrollment_id", log.enrollment_id)
    .in("status", ["scheduled", "in_flight", "pending_connection"])
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!nextLog?.node_id) return;

  await supabase
    .from("sequence_enrollments")
    .update({ current_node_id: nextLog.node_id } as any)
    .eq("id", log.enrollment_id);
}
