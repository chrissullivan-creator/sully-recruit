/**
 * Sequence v2 Scheduler — Flat delay-based model.
 *
 * All actions are pre-scheduled at enrollment time. No branches.
 * Delay hours tick only during the send window ("business hours").
 * LinkedIn messages are parked as pending_connection until accepted.
 * Any reply on any channel stops the entire sequence.
 */
import { task, logger, schedules } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./lib/send-channels";
import { resolveMergeTags, applyMergeTags, formatEmailBody, validateEmail } from "./lib/merge-tags";
import { calculateSendTime, incrementDailySend } from "./lib/send-time-calculator";
import { compareSequenceNodes } from "@/components/sequences/sequenceBranches";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EnrollmentInitPayload {
  enrollmentId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

interface ActionExecutePayload {
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
// Task 1: Initialize enrollment — pre-schedule ALL actions upfront
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceEnrollmentInit = task({
  id: "sequence-enrollment-init",
  retry: { maxAttempts: 3 },
  run: async (payload: EnrollmentInitPayload) => {
    const supabase = getSupabaseAdmin();

    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("*")
      .eq("id", payload.enrollmentId)
      .single();

    if (!enrollment || enrollment.status !== "active") {
      return { action: "skipped", reason: `enrollment_status_${enrollment?.status}` };
    }

    const { data: sequence } = await supabase
      .from("sequences")
      .select("*")
      .eq("id", payload.sequenceId)
      .single();

    if (!sequence) {
      return { action: "error", reason: "sequence_not_found" };
    }

    // Get ALL nodes with their actions
    const { data: nodes } = await supabase
      .from("sequence_nodes")
      .select("id, node_order, branch_id, branch_step_order, sequence_actions(*)")
      .eq("sequence_id", payload.sequenceId);

    if (!nodes || nodes.length === 0) {
      return { action: "error", reason: "no_nodes" };
    }

    const orderedNodes = [...nodes].sort(compareSequenceNodes);
    const senderUserId = sequence.sender_user_id || sequence.created_by || payload.enrolledBy;
    const enrolledAt = new Date(enrollment.enrolled_at);
    let scheduled = 0;
    let pendingConnection = 0;

    // Pre-schedule every action across all nodes
    for (const node of orderedNodes) {
      const actions = (node as any).sequence_actions || [];
      for (const action of actions) {
        if (action.channel === "linkedin_message") {
          // Park as pending_connection — will be scheduled when connection is accepted
          await supabase.from("sequence_step_logs").insert({
            enrollment_id: payload.enrollmentId,
            action_id: action.id,
            node_id: node.id,
            channel: action.channel,
            scheduled_at: null,
            status: "pending_connection",
          });
          pendingConnection++;
        } else {
          // Calculate send time using business-hours model
          const scheduledAt = await calculateSendTime(supabase, {
            startTime: enrolledAt,
            delayHours: Number(action.base_delay_hours) || 0,
            delayMinutes: action.delay_interval_minutes || 0,
            jiggleMinutes: action.jiggle_minutes || 0,
            channel: action.channel,
            sendWindowStart: sequence.send_window_start || "09:00",
            sendWindowEnd: sequence.send_window_end || "18:00",
            accountId: senderUserId,
          });

          await supabase.from("sequence_step_logs").insert({
            enrollment_id: payload.enrollmentId,
            action_id: action.id,
            node_id: node.id,
            channel: action.channel,
            scheduled_at: scheduledAt.toISOString(),
            status: "scheduled",
          });
          scheduled++;
        }
      }
    }

    // Set current_node_id to first node (for tracking)
    await supabase
      .from("sequence_enrollments")
      .update({ current_node_id: orderedNodes[0].id })
      .eq("id", payload.enrollmentId);

    logger.info("Enrollment initialized — all actions pre-scheduled", {
      enrollmentId: payload.enrollmentId,
      scheduled,
      pendingConnection,
    });

    return { action: "initialized", scheduled, pendingConnection };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2: Execute a single scheduled action
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceActionExecute = task({
  id: "sequence-action-execute",
  retry: { maxAttempts: 2 },
  run: async (payload: ActionExecutePayload) => {
    const supabase = getSupabaseAdmin();

    // Re-validate enrollment is still active
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("id", payload.enrollmentId)
      .single();

    if (!enrollment || enrollment.status !== "active") {
      await markStepLog(supabase, payload.stepLogId, "cancelled");
      return { action: "cancelled", reason: "enrollment_not_active" };
    }

    // Reply guard — any reply except connection acceptance stops everything
    const hasReply = await hasRepliedSinceEnrollment(supabase, enrollment);
    if (hasReply) {
      await stopEnrollment(supabase, enrollment, "reply_received");
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
    const senderUserId = sequence.sender_user_id || sequence.created_by || payload.enrolledBy;
    const entityId = payload.candidateId || payload.contactId;
    const entityType = payload.candidateId ? "candidate" : "contact";

    if (!entityId) {
      await markStepLog(supabase, payload.stepLogId, "failed");
      return { action: "error", reason: "no_entity_id" };
    }

    // Manual call → just log it
    if (action.channel === "manual_call") {
      await markStepLog(supabase, payload.stepLogId, "sent", new Date());
      await checkSequenceComplete(supabase, enrollment);
      return { action: "manual_call_logged" };
    }

    // Pre-flight: check recipient has required contact info
    const entityTable = entityType === "candidate" ? "candidates" : "contacts";
    const { data: entityRow } = await supabase
      .from(entityTable)
      .select("email, phone, linkedin_url")
      .eq("id", entityId)
      .maybeSingle();

    if (action.channel === "email" && !entityRow?.email) {
      await markStepSkipped(supabase, payload.stepLogId, "no_email_on_record");
      await checkSequenceComplete(supabase, enrollment);
      return { action: "skipped", reason: "no_email_on_record" };
    }
    if (action.channel === "sms" && !entityRow?.phone) {
      await markStepSkipped(supabase, payload.stepLogId, "no_phone_on_record");
      await checkSequenceComplete(supabase, enrollment);
      return { action: "skipped", reason: "no_phone_on_record" };
    }
    if (action.channel.startsWith("linkedin") && !entityRow?.linkedin_url) {
      await markStepSkipped(supabase, payload.stepLogId, "no_linkedin_url");
      await checkSequenceComplete(supabase, enrollment);
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
      await checkSequenceComplete(supabase, enrollment);
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
            await checkSequenceComplete(supabase, enrollment);
            return { action: "skipped", reason: `invalid_email` };
          }
          sendResult = await sendEmail(
            supabase, to, undefined, formatEmailBody(messageBody), senderUserId,
            undefined, action.use_signature !== false, payload.stepLogId,
          );
          break;
        }
        case "sms":
          sendResult = await sendSms(supabase, to, messageBody, senderUserId);
          break;
        case "linkedin_connection":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_connection");
          break;
        case "linkedin_message":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_message");
          break;
        case "linkedin_inmail":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "recruiter_inmail");
          break;
        default:
          await markStepLog(supabase, payload.stepLogId, "failed");
          return { action: "failed", reason: `unsupported_channel` };
      }
    } catch (err: any) {
      const errMsg = err.message || "";

      // LinkedIn circuit breaker: if Unipile returns limit_exceeded or 429,
      // reschedule the step instead of marking it as permanently failed.
      const isRateLimit =
        errMsg.includes("limit_exceeded") ||
        errMsg.includes("rate limit") ||
        errMsg.includes("429") ||
        errMsg.includes("too many requests");

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

      logger.error("Send failed", { channel: action.channel, error: errMsg });
      await markStepLog(supabase, payload.stepLogId, "failed");
      return { action: "failed", reason: errMsg };
    }

    // Mark sent
    const sentAt = new Date();
    await markStepLog(supabase, payload.stepLogId, "sent", sentAt);

    // Increment daily send counter
    const est = sentAt.toLocaleString("en-US", { timeZone: "America/New_York" });
    const estDate = new Date(est);
    const dateStr = `${estDate.getFullYear()}-${String(estDate.getMonth() + 1).padStart(2, "0")}-${String(estDate.getDate()).padStart(2, "0")}`;
    await incrementDailySend(supabase, senderUserId, action.channel, dateStr);

    // Log outbound message
    const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
    await supabase.from("messages").insert({
      [entityColumn]: entityId,
      conversation_id: conversationId || `seq_${payload.enrollmentId}`,
      channel: action.channel,
      direction: "outbound",
      body: messageBody,
      sent_at: sentAt.toISOString(),
      provider: action.channel.startsWith("linkedin") ? "unipile" : action.channel === "email" ? "microsoft_graph" : "ringcentral",
      external_message_id: sendResult?.messageId || sendResult?.message_id || sendResult?.id,
      owner_id: senderUserId,
    } as any);

    logger.info("Action sent", { channel: action.channel, enrollmentId: payload.enrollmentId, entityId });

    // Check if all actions are now done → mark complete
    await checkSequenceComplete(supabase, enrollment);

    return { action: "sent", channel: action.channel };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sweep — picks up due scheduled actions
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceSweep = schedules.task({
  id: "sequence-sweep-v2",
  cron: "*/3 * * * *", // every 3 minutes, 24/7 (connections can fire anytime)
  run: async () => {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    const { data: dueLogs, error } = await supabase
      .from("sequence_step_logs")
      .select(`
        id, enrollment_id, action_id, node_id, channel,
        sequence_enrollments!inner(
          id, sequence_id, candidate_id, contact_id, status,
          sequences!inner(id, created_by, sender_user_id)
        )
      `)
      .eq("status", "scheduled")
      .lte("scheduled_at", now)
      .eq("sequence_enrollments.status", "active")
      .limit(100);

    if (error) {
      logger.error("Sweep query failed", { error: error.message });
      return { action: "error" };
    }

    // First, recover any rows that were claimed >10 minutes ago and never
    // resolved (action crashed / Trigger.dev died). Resetting them to
    // 'scheduled' lets this sweep pick them up cleanly.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase
      .from("sequence_step_logs")
      .update({ status: "scheduled" } as any)
      .eq("status", "in_flight")
      .lt("updated_at", tenMinAgo);

    if (!dueLogs || dueLogs.length === 0) {
      return { action: "idle", due: 0 };
    }

    logger.info(`Sweep found ${dueLogs.length} due actions`);

    // Atomically claim each row before dispatching. If the next sweep cycle
    // overlaps (or this one retries), the UPDATE only matches rows still in
    // 'scheduled', so a single physical send can only ever be triggered once.
    // sequenceActionExecute moves the row to 'sent'/'failed'/'cancelled' or
    // resets status back to 'scheduled' (rate-limited path), so it never
    // strands. The 10-minute recovery above handles outright crashes.
    const claimedIds: string[] = [];
    const claimedById = new Map<string, any>(dueLogs.map((l: any) => [l.id, l]));
    for (const log of dueLogs) {
      const { data: claimed, error: claimErr } = await supabase
        .from("sequence_step_logs")
        .update({ status: "in_flight" } as any)
        .eq("id", log.id)
        .eq("status", "scheduled")
        .select("id")
        .maybeSingle();
      if (claimErr) {
        logger.warn("Claim failed (non-fatal, skipping row)", { id: log.id, error: claimErr.message });
        continue;
      }
      if (claimed?.id) claimedIds.push(claimed.id);
    }

    for (const id of claimedIds) {
      const log = claimedById.get(id)!;
      const enrollment = log.sequence_enrollments;
      const sequence = enrollment?.sequences;

      await sequenceActionExecute.trigger({
        stepLogId: log.id,
        enrollmentId: enrollment.id,
        actionId: log.action_id,
        nodeId: log.node_id,
        sequenceId: enrollment.sequence_id,
        candidateId: enrollment.candidate_id || undefined,
        contactId: enrollment.contact_id || undefined,
        enrolledBy: sequence?.sender_user_id || sequence?.created_by,
        accountId: undefined,
      });
    }

    return { action: "dispatched", count: claimedIds.length, found: dueLogs.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending-connection sweeper — LinkedIn invites that never get accepted
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_CONNECTION_TTL_DAYS = 21;

/**
 * Cancels any LinkedIn `pending_connection` step log that has been waiting
 * longer than PENDING_CONNECTION_TTL_DAYS. Without this, an unaccepted
 * invite leaves the enrollment perpetually "incomplete" — checkSequenceComplete
 * counts pending_connection as not-done, so the enrollment row never closes
 * out and the UI shows it as still active.
 *
 * Runs once a day at 02:00 UTC (off-hours so it doesn't compete with the
 * 3-minute send sweep).
 */
export const pendingConnectionTimeout = schedules.task({
  id: "sequence-pending-connection-timeout",
  cron: "0 2 * * *",
  run: async () => {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() - PENDING_CONNECTION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Find every stale pending_connection log + the enrollment it belongs to,
    // so we can advance the enrollment's progress + close it out if needed.
    const { data: stale, error } = await supabase
      .from("sequence_step_logs")
      .select("id, enrollment_id, sequence_enrollments!inner(id, candidate_id, contact_id, status)")
      .eq("status", "pending_connection")
      .lte("created_at", cutoff)
      .limit(200);

    if (error) {
      logger.error("Pending-connection sweep query failed", { error: error.message });
      return { action: "error" };
    }

    if (!stale || stale.length === 0) return { action: "idle" };

    logger.info(`Cancelling ${stale.length} pending_connection logs older than ${PENDING_CONNECTION_TTL_DAYS}d`);

    const ids = stale.map((s: any) => s.id);
    await supabase
      .from("sequence_step_logs")
      .update({ status: "cancelled", skip_reason: "connection_request_expired" } as any)
      .in("id", ids);

    // For each enrollment touched, advance the current_node_id pointer + run
    // checkSequenceComplete so we either move to the next step or mark it
    // completed. Dedup enrollments first.
    const seen = new Set<string>();
    for (const s of stale as any[]) {
      const enr = s.sequence_enrollments;
      if (!enr || seen.has(enr.id)) continue;
      seen.add(enr.id);
      await advanceCurrentNode(supabase, s.id);
      await checkSequenceComplete(supabase, enr);
    }

    return { action: "expired", count: ids.length, enrollments: seen.size };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Check if ALL actions for this enrollment are done (sent/failed/skipped/cancelled).
 *  If none are pending or pending_connection, mark enrollment as completed. */
async function checkSequenceComplete(supabase: any, enrollment: any): Promise<void> {
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

async function hasRepliedSinceEnrollment(supabase: any, enrollment: any): Promise<boolean> {
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

  logger.info("Enrollment stopped", { enrollmentId: enrollment.id, trigger });

  if (replyText && trigger === "reply_received") {
    await triggerSentimentAnalysis(supabase, enrollment, replyText);
  }
}

async function triggerSentimentAnalysis(supabase: any, enrollment: any, replyText: string): Promise<void> {
  try {
    const { data: sequence } = await supabase
      .from("sequences")
      .select("objective, audience_type, job_id, jobs(title)")
      .eq("id", enrollment.sequence_id)
      .single();

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/ask-joe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "sentiment_analysis",
        reply_text: replyText,
        audience_type: sequence?.audience_type || "candidates",
        job_title: sequence?.jobs?.title || "",
        sequence_objective: sequence?.objective || "",
      }),
    });

    if (response.ok) {
      const result = await response.json();

      await supabase
        .from("sequence_step_logs")
        .update({ reply_received_at: new Date().toISOString(), reply_text: replyText, sentiment: result.sentiment, sentiment_reason: result.reason })
        .eq("enrollment_id", enrollment.id)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1);

      const entityTable = enrollment.candidate_id ? "candidates" : "contacts";
      const entityId = enrollment.candidate_id || enrollment.contact_id;
      await supabase
        .from(entityTable)
        .update({ last_sequence_sentiment: result.sentiment, last_sequence_sentiment_note: result.reason } as any)
        .eq("id", entityId);

      if (enrollment.candidate_id && sequence?.job_id && result.pipeline_status) {
        await supabase
          .from("candidate_jobs")
          .update({ stage: result.pipeline_status } as any)
          .eq("candidate_id", enrollment.candidate_id)
          .eq("job_id", sequence.job_id);
      }
    }
  } catch (err: any) {
    logger.error("Sentiment analysis failed", { error: err.message });
  }
}

async function getSenderName(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();
  return profile?.full_name || `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "";
}

async function markStepLog(supabase: any, stepLogId: string, status: string, sentAt?: Date): Promise<void> {
  const update: any = { status };
  if (sentAt) update.sent_at = sentAt.toISOString();
  await supabase.from("sequence_step_logs").update(update).eq("id", stepLogId);
  await advanceCurrentNode(supabase, stepLogId);
}

async function markStepSkipped(supabase: any, stepLogId: string, reason: string): Promise<void> {
  await supabase.from("sequence_step_logs").update({ status: "skipped", skip_reason: reason } as any).eq("id", stepLogId);
  await advanceCurrentNode(supabase, stepLogId);
}

/**
 * Move the enrollment's `current_node_id` forward to the next not-yet-fired
 * step (scheduled / in_flight / pending_connection), so the UI can show
 * accurate progress like "step 3 of 5". If no more steps are pending the
 * caller's checkSequenceComplete() handles the completion transition.
 */
async function advanceCurrentNode(supabase: any, stepLogId: string): Promise<void> {
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
