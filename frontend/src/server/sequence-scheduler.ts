/**
 * Sequence v2 Scheduler — Flat delay-based model.
 *
 * All actions are pre-scheduled at enrollment time. No branches.
 * Delay hours tick only during the send window ("business hours").
 * LinkedIn messages are parked as pending_connection until accepted.
 * Any reply on any channel stops the entire sequence.
 */
const logger = console;
import { getSupabaseAdmin } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./lib/send-channels";
import { resolveMergeTags, applyMergeTags, formatEmailBody, validateEmail } from "./lib/merge-tags";
import { calculateSendTime, incrementDailySend } from "./lib/send-time-calculator";
import { canonicalChannel } from "./lib/unipile-v2";
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
// Legacy v2 Trigger.dev sequence engine (sequenceEnrollmentInit,
// sequenceActionExecute, sequenceSweep) was deleted during the Inngest
// cutover. The Inngest sequence-run function in
// frontend/src/inngest/functions/sequence-run.ts owns all enrollment
// processing now — operators must run sequence/migrate-to-inngest.requested
// for any sequence still on engine=trigger BEFORE deploying this branch,
// otherwise those enrollments freeze (no engine to dispatch them).
//
// What remains in this file: shared helpers used by the Inngest functions —
// runPendingConnectionTimeout, stopEnrollment, hasRepliedSinceEnrollment,
// the LinkedIn rate-limit cooldown helpers, etc.
// ─────────────────────────────────────────────────────────────────────────────


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
/**
 * Pure run body — extracted so the Inngest port and the Trigger.dev
 * scheduled task share one source of truth. Phase 5b deletes the
 * Trigger.dev wrapper.
 */
export async function runPendingConnectionTimeout() {
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
}

// MIGRATED to Inngest — see frontend/src/inngest/functions/pending-connection-timeout.ts.
// Stub keeps the Trigger.dev task registry quiet; Inngest owns the cron.
export const pendingConnectionTimeout = null;

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

/**
 * After a step actually sends, push the next pending step's
 * scheduled_at to actualSentAt + that step's delay (respecting send
 * window + caps via calculateSendTime). Without this, a step that
 * was delayed by daily cap or rate-limit retry leaks an unintended
 * shorter gap to the next step.
 *
 * Only touches the immediate next step — when *that* step executes,
 * it re-anchors its own next step the same way. Cascading is
 * automatic and incremental.
 *
 * pending_connection logs are skipped; they get scheduled by the
 * webhook / fallback when the connection is accepted.
 */
async function reanchorNextStep(
  supabase: any,
  enrollmentId: string,
  currentStepLogId: string,
  actualSentAt: Date,
  sequence: any,
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
  if (!action) return;

  const senderUserId = sequence.sender_user_id || sequence.created_by;
  const newScheduledAt = await calculateSendTime(supabase, {
    startTime: actualSentAt,
    delayHours: Number(action.base_delay_hours) || 0,
    delayMinutes: action.delay_interval_minutes || 0,
    jiggleMinutes: action.jiggle_minutes || 0,
    channel: action.channel,
    sendWindowStart: sequence.send_window_start || "09:00",
    sendWindowEnd: sequence.send_window_end || "18:00",
    accountId: senderUserId,
    weekdaysOnly: sequence.weekdays_only === true,
  });

  // Only update if the new time is later than what we already have.
  // We never want to *pull forward* a step — bringing it earlier
  // could violate the cumulative-delay contract and surprise the
  // recipient. Push-back only.
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
