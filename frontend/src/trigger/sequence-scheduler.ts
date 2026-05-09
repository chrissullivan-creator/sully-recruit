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
import { calculateSendTime } from "./lib/send-time-calculator";
import {
  runSequenceAction,
  advanceCurrentNode,
  checkSequenceComplete,
  stopEnrollment as runnerStopEnrollment,
  type ActionExecutePayload,
} from "./lib/sequence-runner";
import { compareSequenceNodes } from "@/components/sequences/sequenceBranches";

/**
 * Re-exported so the existing webhook handlers
 * (`webhook-microsoft.ts`, `webhook-ringcentral.ts`, `webhook-unipile.ts`)
 * keep importing `stopEnrollment` from this file. The implementation
 * lives in `./lib/sequence-runner.ts` so both engines share it.
 */
export const stopEnrollment = runnerStopEnrollment;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrollmentInitPayload {
  enrollmentId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1: Initialize enrollment — pre-schedule ALL actions upfront
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Engine-neutral run body — extracted so the Inngest port at
 * api/lib/inngest/functions/sequence-enrollment-init.ts and the
 * Trigger.dev wrapper below share a single source of truth.
 *
 * Pre-schedules every sequence_step_log row this enrollment will need,
 * regardless of `sequences.engine`. The right sweep claims them later
 * — Trigger.dev's sweep filters engine='trigger', Inngest's filters
 * engine='inngest', so a single row only fires once.
 */
export async function runSequenceEnrollmentInit(payload: EnrollmentInitPayload) {
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

    // Engine-agnostic init: step_logs are pre-scheduled (status='scheduled' with
    // computed scheduled_at) regardless of `sequence.engine`. The right sweep
    // claims them — Trigger.dev sweep filters engine='trigger', Inngest sweep
    // filters engine='inngest', so a row only ever fires once.

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
    let preSkipped = 0;

    // Idempotency for re-pace: load every non-cancelled step_log this
    // enrollment already has. Cancelled logs were cleared by the
    // re-pace path and are eligible for re-scheduling. Anything else
    // (sent / skipped / failed / pending_connection that's still live)
    // is terminal — we must not insert a duplicate. Without this gate,
    // re-pacing an enrollment that's already partway through fires
    // step 1 again immediately, double-mailing the recipient.
    const { data: existingLogs } = await supabase
      .from("sequence_step_logs")
      .select("action_id, status, sent_at, scheduled_at")
      .eq("enrollment_id", payload.enrollmentId)
      .not("status", "eq", "cancelled");
    const existingByAction = new Map<string, { status: string; sent_at: string | null; scheduled_at: string | null }>();
    for (const log of (existingLogs || []) as any[]) {
      if (log.action_id) existingByAction.set(log.action_id, log);
    }

    // Pre-fetch the recipient's contact fields once so we can pre-skip
    // steps the recipient can't receive (no email → skip email, no
    // linkedin_url → skip every linkedin_*) without round-tripping at
    // each step.
    const recipientId = enrollment.candidate_id || enrollment.contact_id;
    let recipientEmail: string | null = null;
    let recipientLinkedin: string | null = null;
    let recipientPhone: string | null = null;
    // Already-connected on LinkedIn? If so we don't send a connection
    // request (Unipile would 422 it as "already connected", which the
    // execute path can't classify as rate-limit and marks failed). We
    // also schedule any linkedin_message steps directly instead of
    // parking them as pending_connection.
    let recipientLinkedinConnected = false;
    if (recipientId) {
      const { data: person } = await supabase
        .from("people")
        .select("type, primary_email, work_email, personal_email, phone, linkedin_url")
        .eq("id", recipientId)
        .maybeSingle();
      if (person) {
        recipientEmail =
          person.type === "candidate"
            ? (person.personal_email || person.primary_email)
            : (person.work_email || person.primary_email);
        recipientLinkedin = person.linkedin_url || null;
        recipientPhone = person.phone || null;
      }

      // candidate_channels.is_connected gets stamped by either the
      // Unipile webhook (advanceOnConnectionAccepted) or the
      // check-connections polling fallback. Either way, when we see
      // is_connected=true we skip the linkedin_connection step
      // entirely and land linkedin_message logs as 'scheduled'
      // directly rather than parking them as pending_connection.
      const { data: ch } = await supabase
        .from("candidate_channels")
        .select("is_connected")
        .eq("candidate_id", recipientId)
        .eq("channel", "linkedin")
        .maybeSingle();
      recipientLinkedinConnected = (ch as any)?.is_connected === true;
    }

    function recipientHasRequired(channel: string): boolean {
      if (channel === "email") return !!recipientEmail;
      if (channel === "sms") return !!recipientPhone;
      if (channel.startsWith("linkedin")) return !!recipientLinkedin;
      return true; // manual_call, phone — no pre-flight
    }

    // Each action's `base_delay_hours` is the gap *between* this step and
    // the previous SCHEDULED one — not from enrollment. We carry the
    // previous scheduled step's send time forward as the next step's
    // start. Crucially: pre-skipped steps DON'T advance the cursor, so
    // when the email step gets skipped because the person has no email,
    // the InMail step takes over the email's slot in the schedule rather
    // than waiting 3h behind a step that never fires.
    let prevSendTime = enrolledAt;
    for (const node of orderedNodes) {
      const actions = (node as any).sequence_actions || [];
      for (const action of actions) {
        // Skip actions that already have a non-cancelled log. Advance
        // the cursor to whichever timestamp anchors the next step:
        // sent_at if we shipped it, scheduled_at if it's still queued
        // (pending_connection waiting on the webhook).
        const existing = existingByAction.get(action.id);
        if (existing) {
          if (existing.status === "sent" && existing.sent_at) {
            prevSendTime = new Date(existing.sent_at);
          } else if (existing.status === "scheduled" && existing.scheduled_at) {
            prevSendTime = new Date(existing.scheduled_at);
          }
          // skipped / failed / pending_connection don't advance — same
          // as the pre-skip semantics for the live insert path.
          continue;
        }

        // Pre-skip if the recipient lacks the required field for this
        // channel. Logged as 'skipped' with no scheduled_at so it shows
        // up in step history but never fires. Doesn't advance the
        // cursor, so the next eligible step takes this slot.
        if (!recipientHasRequired(action.channel)) {
          await supabase.from("sequence_step_logs").insert({
            enrollment_id: payload.enrollmentId,
            action_id: action.id,
            node_id: node.id,
            channel: action.channel,
            scheduled_at: null,
            status: "skipped",
            skip_reason:
              action.channel === "email" ? "no_email_on_record" :
              action.channel === "sms" ? "no_phone_on_record" :
              action.channel.startsWith("linkedin") ? "no_linkedin_url" :
              "missing_recipient_field",
          });
          preSkipped++;
          continue;
        }

        // Already connected on LinkedIn → skip the connection request
        // and let downstream linkedin_message steps schedule directly
        // (they fall through to the normal scheduled path below
        // because the linkedin_message branch checks for connection
        // state too). Doesn't advance the cursor — same semantics as
        // a missing-channel pre-skip.
        if (action.channel === "linkedin_connection" && recipientLinkedinConnected) {
          await supabase.from("sequence_step_logs").insert({
            enrollment_id: payload.enrollmentId,
            action_id: action.id,
            node_id: node.id,
            channel: action.channel,
            scheduled_at: null,
            status: "skipped",
            skip_reason: "already_connected",
          });
          preSkipped++;
          continue;
        }

        if (action.channel === "linkedin_message" && !recipientLinkedinConnected) {
          // Not connected yet — park as pending_connection. Webhook
          // handler will schedule it once the invite is accepted.
          // Don't advance prevSendTime; the webhook handler will use
          // 4h post-accept and downstream steps stay anchored to the
          // last scheduled action.
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
          // Floor the cursor at NOW so resumed sequences (or any
          // re-pace where the last sent step was long ago) don't
          // schedule overdue steps that would all fire at once on
          // the next sweep tick. If prevSendTime is already in the
          // future, this is a no-op.
          if (prevSendTime.getTime() < Date.now()) prevSendTime = new Date();

          // Calculate send time using business-hours model, anchored to the
          // previous step's send time (cumulative).
          const scheduledAt = await calculateSendTime(supabase, {
            startTime: prevSendTime,
            delayHours: Number(action.base_delay_hours) || 0,
            delayMinutes: action.delay_interval_minutes || 0,
            jiggleMinutes: action.jiggle_minutes || 0,
            channel: action.channel,
            sendWindowStart: sequence.send_window_start || "09:00",
            sendWindowEnd: sequence.send_window_end || "18:00",
            accountId: senderUserId,
            weekdaysOnly: sequence.weekdays_only === true,
          });

          await supabase.from("sequence_step_logs").insert({
            enrollment_id: payload.enrollmentId,
            action_id: action.id,
            node_id: node.id,
            channel: action.channel,
            scheduled_at: scheduledAt.toISOString(),
            status: "scheduled",
          });
          prevSendTime = scheduledAt;
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
      preSkipped,
    });

    return { action: "initialized", scheduled, pendingConnection, preSkipped };
}

/**
 * Trigger.dev wrapper — kept while live `tasks.trigger("sequence-enrollment-init", …)`
 * call sites still exist (the new Inngest path is the primary route).
 * Both engines call into the same `runSequenceEnrollmentInit` helper.
 *
 * Once the Inngest event-driven path is verified for ~24h, this
 * wrapper can be retired in a follow-up PR alongside any remaining
 * `tasks.trigger("sequence-enrollment-init")` call sites.
 */
export const sequenceEnrollmentInit = task({
  id: "sequence-enrollment-init",
  retry: { maxAttempts: 3 },
  run: (payload: EnrollmentInitPayload) => runSequenceEnrollmentInit(payload),
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2: Execute a single scheduled action
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceActionExecute = task({
  id: "sequence-action-execute",
  retry: { maxAttempts: 2 },
  run: async (payload: ActionExecutePayload) => {
    const supabase = getSupabaseAdmin();
    return runSequenceAction(supabase, payload, logger);
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

    // engine='trigger' filter: the Inngest cutover (see migration
    // 20260509000000_add_sequences_engine_column.sql) flips per-sequence to
    // 'inngest' as it migrates them. This sweep MUST skip those rows so the
    // two engines can never both fire the same step_log.
    const { data: dueLogs, error } = await supabase
      .from("sequence_step_logs")
      .select(`
        id, enrollment_id, action_id, node_id, channel,
        sequence_enrollments!inner(
          id, sequence_id, candidate_id, contact_id, status,
          sequences!inner(id, status, engine, created_by, sender_user_id)
        )
      `)
      .eq("status", "scheduled")
      .lte("scheduled_at", now)
      .eq("sequence_enrollments.status", "active")
      .eq("sequence_enrollments.sequences.status", "active")
      .eq("sequence_enrollments.sequences.engine", "trigger")
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

// pendingConnectionTimeout has moved to Inngest:
// frontend/api/lib/inngest/functions/pending-connection-timeout.ts
