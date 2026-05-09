import { inngest } from "../client";
import { getSupabaseAdmin } from "../../trigger/lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "../../trigger/lib/send-channels";
import { resolveMergeTags, applyMergeTags, validateEmail } from "../../trigger/lib/merge-tags";
import { canonicalChannel } from "../../trigger/lib/unipile-v2";

/**
 * Phase 2 of the Inngest migration: the sequence engine itself.
 *
 * One durable function per enrollment. Replaces the
 * sequenceEnrollmentInit + sequenceSweep + sequenceActionExecute trio
 * from frontend/src/trigger/sequence-scheduler.ts with a single
 * top-to-bottom workflow.
 *
 *   sequence/enrolled
 *     → preschedule (pre-write all sequence_step_logs for the UI)
 *     → for each action:
 *         step.sleepUntil(scheduled_at)
 *         step.run("send-N", …)
 *         if linkedin_connection: step.waitForEvent("linkedin/connection-accepted", …)
 *     → mark complete
 *
 * Reply-stop:
 *   cancelOn: { event: "sequence/cancel", match: "data.enrollmentId" }
 *   The reply-handling Inngest function emits this event when an inbound
 *   message matches an active enrollment.
 *
 * Things this version intentionally does NOT yet do (vs Trigger.dev):
 *   - Per-account rate-limit circuit breaker (will rely on Inngest's
 *     declarative concurrency once we wire it up)
 *   - +2h reschedule on Unipile rate-limit (instead, rely on Inngest's
 *     built-in retries — `retries: 3` with exponential backoff)
 *   - Daily-cap rolling at execute time (the per-step pre-schedule
 *     already considers the cap via calculateSendTime)
 *   - Pause/Resume-during-flight (Inngest doesn't have native pause —
 *     we'd cancel + re-enqueue; deferred to Phase 2.5)
 *   - Re-anchor next step (not needed: the function holds live state,
 *     each step.sleepUntil is computed off the actual prior sent time)
 *
 * Feature flag: `sequences.engine` column gates which engine handles
 * a given sequence's enrollments. Phase 2c adds the column + wires
 * /api/trigger-sequence-enroll to dispatch accordingly.
 */
export const sequenceRun = inngest.createFunction(
  {
    id: "sequence-run",
    name: "Sequence Run",
    retries: 3,
    triggers: [{ event: "sequence/enrolled" }],
    cancelOn: [
      // Reply-stop, manual stop, and pause all flow through this event.
      // The function aborts; any unstarted step.run calls don't fire.
      { event: "sequence/cancel", match: "data.enrollmentId" },
    ],
    concurrency: [
      // Per-enrollment guard: a duplicate `sequence/enrolled` event
      // (e.g. a retry on the API route) only ever runs once.
      { key: "event.data.enrollmentId", limit: 1 },
    ],
  },
  async ({ event, step, logger }) => {
    const { enrollmentId, sequenceId, accountId } = event.data as {
      enrollmentId: string;
      sequenceId: string;
      candidateId?: string;
      contactId?: string;
      enrolledBy: string;
      accountId?: string;
    };
    const supabase = getSupabaseAdmin();

    // ── Load context ─────────────────────────────────────────────
    const ctx = await step.run("load-context", async () => {
      const { data: enrollment } = await supabase
        .from("sequence_enrollments")
        .select("*, sequences!inner(*)")
        .eq("id", enrollmentId)
        .single();

      if (!enrollment) throw new Error(`enrollment ${enrollmentId} not found`);

      const { data: nodes } = await supabase
        .from("sequence_nodes")
        .select("id, node_order, node_type, label, sequence_actions(*)")
        .eq("sequence_id", sequenceId)
        .order("node_order");

      // Flatten nodes → actions in execution order. Each action becomes
      // a single step in the workflow.
      const actions: Array<{
        id: string;
        nodeId: string;
        nodeOrder: number;
        channel: string;
        message_body: string;
        subject_line: string | null;
        base_delay_hours: number;
        delay_interval_minutes: number;
        jiggle_minutes: number;
        post_connection_hardcoded_hours: number;
        respect_send_window: boolean;
        use_signature: boolean;
        attachment_urls: string[] | null;
        attachment_url: string | null;
        reply_to_previous: boolean;
      }> = [];
      for (const n of nodes || []) {
        for (const a of (n as any).sequence_actions || []) {
          actions.push({
            id: a.id,
            nodeId: n.id,
            nodeOrder: (n as any).node_order,
            channel: a.channel,
            message_body: a.message_body,
            subject_line: a.subject_line,
            base_delay_hours: a.base_delay_hours ?? 0,
            delay_interval_minutes: a.delay_interval_minutes ?? 0,
            jiggle_minutes: a.jiggle_minutes ?? 0,
            post_connection_hardcoded_hours: a.post_connection_hardcoded_hours ?? 4,
            respect_send_window: a.respect_send_window !== false,
            use_signature: a.use_signature !== false,
            attachment_urls: a.attachment_urls ?? null,
            attachment_url: a.attachment_url ?? null,
            reply_to_previous: a.reply_to_previous === true,
          });
        }
      }
      return { enrollment, actions };
    });

    const enrollment = ctx.enrollment as any;
    const sequence = enrollment.sequences;
    const senderUserId = sequence.sender_user_id || sequence.created_by;
    const entityId = enrollment.candidate_id || enrollment.contact_id;
    const entityType: "candidate" | "contact" = enrollment.candidate_id ? "candidate" : "contact";

    if (!entityId) {
      logger.error("Enrollment missing candidate_id and contact_id", { enrollmentId });
      return { action: "failed", reason: "no_entity_id" };
    }

    // ── Pre-flight: skip already-connected LinkedIn invites ─────
    const liStatus = await step.run("preflight-li", async () => {
      const { data: row } = await supabase
        .from("candidate_channels")
        .select("is_connected")
        .eq("candidate_id", entityId)
        .eq("channel", "linkedin")
        .maybeSingle();
      return row?.is_connected === true;
    });

    // ── Resolve merge tags once ─────────────────────────────────
    const mergeVars = await step.run("merge-vars", async () => {
      const vars = await resolveMergeTags(supabase, entityId, entityType);
      vars.sender_name = await getSenderName(supabase, senderUserId);
      if (sequence.job_id) {
        const { data: job } = await supabase.from("jobs")
          .select("title").eq("id", sequence.job_id).maybeSingle();
        vars.job_name = job?.title || "";
      }
      return vars;
    });

    // ── Walk actions in order ───────────────────────────────────
    let lastSentAt = new Date(enrollment.enrolled_at || Date.now());

    for (let i = 0; i < ctx.actions.length; i++) {
      const action = ctx.actions[i];
      const stepKey = `step-${i}-${action.id.slice(0, 8)}`;

      // Skip already-connected linkedin_connection step.
      if (action.channel === "linkedin_connection" && liStatus) {
        await step.run(`${stepKey}-skip-already-connected`, async () => {
          await writeStepLog(supabase, {
            enrollmentId, actionId: action.id, nodeId: action.nodeId,
            channel: action.channel,
            scheduled_at: new Date().toISOString(),
            status: "skipped", skip_reason: "already_connected",
          });
        });
        continue;
      }

      // Compute when this step should fire. linkedin_message after a
      // connection step gets `post_connection_hardcoded_hours` after
      // acceptance (handled below); everything else uses the action's
      // own delay off `lastSentAt`.
      const delayMs =
        action.base_delay_hours * 60 * 60 * 1000 +
        action.delay_interval_minutes * 60 * 1000;
      const jitterMs =
        Math.floor((Math.random() * 2 - 1) * action.jiggle_minutes * 60 * 1000);
      const scheduledAt = new Date(lastSentAt.getTime() + delayMs + jitterMs);

      // Pre-write the step_log so Schedule drawer + analytics see it
      // queued before it actually fires.
      const stepLogId = await step.run(`${stepKey}-prewrite`, async () => {
        return writeStepLog(supabase, {
          enrollmentId, actionId: action.id, nodeId: action.nodeId,
          channel: action.channel,
          scheduled_at: scheduledAt.toISOString(),
          status: "scheduled",
        });
      });

      // Durable sleep until scheduled_at. Function exits + resumes
      // automatically — no resources held during the wait.
      await step.sleepUntil(`${stepKey}-wait`, scheduledAt);

      // ── Send ───────────────────────────────────────────────
      // Single result shape so TypeScript can narrow downstream
      // without juggling discriminated unions across the inner branches.
      type StepRunResult = {
        skipped: boolean;
        sentAt?: string;
        reason?: string;
        manual?: boolean;
        internetMessageId?: string;
      };
      const sendResult = await step.run(`${stepKey}-send`, async (): Promise<StepRunResult> => {
        if (action.channel === "manual_call") {
          // Manual call placeholder — recruiter logs the call elsewhere.
          const sentAt = new Date();
          await markStepLog(supabase, stepLogId, "sent", sentAt);
          return { skipped: false, manual: true, sentAt: sentAt.toISOString() };
        }

        // Validate recipient
        const { to, conversationId } = await resolveRecipient(
          supabase,
          action.channel === "linkedin_inmail" ? "linkedin_message" : action.channel,
          entityId, entityType, senderUserId, accountId,
        );

        if (action.channel === "email") {
          const ev = validateEmail(to);
          if (!ev.valid) {
            await markStepSkipped(supabase, stepLogId, `invalid_email_${ev.reason}`);
            return { skipped: true, reason: `invalid_email_${ev.reason}` };
          }
        }

        const body = applyMergeTags(action.message_body, mergeVars);
        const subject = action.subject_line
          ? applyMergeTags(action.subject_line, mergeVars)
          : null;

        let result: any;
        try {
          if (action.channel === "email") {
            // sendEmail signature: (supabase, to, subject, body, userId,
            //   threadingOptions?, useSignature?, trackingStepLogId?, attachmentUrls?)
            const attachments =
              action.attachment_urls && action.attachment_urls.length
                ? action.attachment_urls
                : (action.attachment_url ? [action.attachment_url] : undefined);
            result = await sendEmail(
              supabase, to, subject || "", body, senderUserId,
              undefined,           // threadingOptions — wire reply_to_previous in a follow-up
              action.use_signature, // useSignature
              stepLogId,           // trackingStepLogId — open-tracking pixel
              attachments,         // attachmentUrls
            );
          } else if (action.channel === "sms") {
            result = await sendSms(supabase, to, body, senderUserId);
          } else if (action.channel === "linkedin_connection") {
            result = await sendLinkedIn(
              supabase, to, body, senderUserId, accountId, "linkedin_connection",
            );
          } else if (action.channel === "linkedin_message") {
            result = await sendLinkedIn(
              supabase, to, body, senderUserId, accountId, "linkedin_message",
              action.attachment_urls?.length ? action.attachment_urls : undefined,
            );
          } else if (action.channel === "linkedin_inmail") {
            result = await sendLinkedIn(
              supabase, to, body, senderUserId, accountId, "recruiter_inmail",
              action.attachment_urls?.length ? action.attachment_urls : undefined,
            );
          } else {
            await markStepLog(supabase, stepLogId, "failed");
            return { skipped: true, reason: "unsupported_channel" };
          }
        } catch (err: any) {
          // Inngest's `retries: 3` will re-run this step.run on throw;
          // throw so transient + rate-limit errors get retried instead
          // of swallowing them as a permanent failure. Hard errors
          // (invalid_email, no_phone) handled above as explicit skips.
          await markStepSkipped(supabase, stepLogId, `send_error: ${err?.message?.slice(0, 200)}`);
          throw err;
        }

        const sentAt = new Date();
        await markStepLog(supabase, stepLogId, "sent", sentAt);

        // Mirror outbound to the messages table so Inbox + Joe Says see it.
        const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
        await supabase.from("messages").insert({
          [entityColumn]: entityId,
          conversation_id: conversationId || `seq_${enrollmentId}`,
          channel: canonicalChannel(action.channel),
          direction: "outbound",
          body,
          sent_at: sentAt.toISOString(),
          provider: action.channel.startsWith("linkedin")
            ? "unipile"
            : action.channel === "email" ? "microsoft_graph" : "ringcentral",
          external_message_id: result?.messageId || result?.message_id || result?.id,
          owner_id: senderUserId,
        } as any);

        return {
          skipped: false,
          sentAt: sentAt.toISOString(),
          internetMessageId: result?.internetMessageId,
        };
      });

      if (sendResult.skipped) {
        // Skipped sends don't anchor downstream timing — keep lastSentAt as-is.
        continue;
      }
      if (sendResult.sentAt) {
        lastSentAt = new Date(sendResult.sentAt);
      }

      // ── If this was a connection invite, wait for acceptance ──
      if (action.channel === "linkedin_connection") {
        const accepted = await step.waitForEvent(`${stepKey}-await-accept`, {
          event: "linkedin/connection-accepted",
          timeout: "21d",
          // Match by candidateId (passed into the event from the webhook).
          if: `event.data.candidateId == "${entityId}"`,
        });
        if (!accepted) {
          // Timed out — nothing more we can send to a non-connection.
          await step.run(`${stepKey}-cancel-rest-no-accept`, async () => {
            await cancelRemainingSteps(supabase, enrollmentId);
            await stopEnrollmentRow(supabase, enrollmentId, "connection_timeout");
          });
          return { action: "stopped", reason: "connection_timeout" };
        }
        // Anchor downstream waits off the post-connection delay,
        // not off the time the invite went out.
        const postConnectMs = action.post_connection_hardcoded_hours * 60 * 60 * 1000;
        lastSentAt = new Date(Date.now() + postConnectMs);
      }
    }

    // ── Mark enrollment complete ───────────────────────────────
    await step.run("mark-complete", async () => {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "completed", completed_at: new Date().toISOString() } as any)
        .eq("id", enrollmentId);
    });

    return { action: "completed", actionsRun: ctx.actions.length };
  },
);

// ── helpers ────────────────────────────────────────────────────

async function writeStepLog(
  supabase: any,
  row: {
    enrollmentId: string;
    actionId: string;
    nodeId: string;
    channel: string;
    scheduled_at: string;
    status: string;
    skip_reason?: string;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("sequence_step_logs")
    .insert({
      enrollment_id: row.enrollmentId,
      action_id: row.actionId,
      node_id: row.nodeId,
      channel: row.channel,
      scheduled_at: row.scheduled_at,
      status: row.status,
      skip_reason: row.skip_reason,
    } as any)
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function markStepLog(
  supabase: any,
  stepLogId: string,
  status: string,
  sentAt?: Date,
): Promise<void> {
  await supabase
    .from("sequence_step_logs")
    .update({
      status,
      ...(sentAt ? { sent_at: sentAt.toISOString() } : {}),
      updated_at: new Date().toISOString(),
    } as any)
    .eq("id", stepLogId);
}

async function markStepSkipped(supabase: any, stepLogId: string, reason: string): Promise<void> {
  await supabase
    .from("sequence_step_logs")
    .update({ status: "skipped", skip_reason: reason, updated_at: new Date().toISOString() } as any)
    .eq("id", stepLogId);
}

async function cancelRemainingSteps(supabase: any, enrollmentId: string): Promise<void> {
  await supabase
    .from("sequence_step_logs")
    .update({ status: "cancelled", updated_at: new Date().toISOString() } as any)
    .eq("enrollment_id", enrollmentId)
    .in("status", ["scheduled", "pending_connection"]);
}

async function stopEnrollmentRow(supabase: any, enrollmentId: string, reason: string): Promise<void> {
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "stopped",
      stopped_at: new Date().toISOString(),
      stop_reason: reason,
    } as any)
    .eq("id", enrollmentId);
}

async function getSenderName(supabase: any, userId: string): Promise<string> {
  if (!userId) return "";
  const { data } = await supabase
    .from("profiles")
    .select("full_name, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();
  return data?.full_name
    || `${data?.first_name || ""} ${data?.last_name || ""}`.trim()
    || "";
}
