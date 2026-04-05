import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { processSequenceStep } from "./sequence-step";

/**
 * Sequence sweep — runs every 5 minutes.
 * Fetches active enrollments due now, updates tracking statuses,
 * then fans out to per-enrollment step tasks.
 */
export const sequenceSweep = schedules.task({
  id: "sequence-sweep",
  // Register a 5-minute cron in Trigger.dev dashboard:
  // cron: "*/5 * * * *"
  run: async () => {
    const supabase = getSupabaseAdmin();
    const now = new Date();

    logger.info("Sequence sweep started", { timestamp: now.toISOString() });

    // ── 0. Update open/reply tracking statuses ──────────────────────
    await updateTrackingStatuses(supabase, now);

    // ── 1. Fetch active enrollments that are due ────────────────────
    const { data: enrollments, error: enrollError } = await supabase
      .from("sequence_enrollments")
      .select(`
        id,
        sequence_id,
        candidate_id,
        contact_id,
        current_step_order,
        next_step_at,
        account_id,
        enrolled_by,
        enrolled_at,
        sequences!inner (
          id,
          stop_on_reply,
          channel
        )
      `)
      .eq("status", "active")
      .lte("next_step_at", now.toISOString());

    if (enrollError) {
      logger.error("Error fetching enrollments", { error: enrollError });
      throw enrollError;
    }

    if (!enrollments || enrollments.length === 0) {
      logger.info("No enrollments due");
      return { processed: 0, message: "No enrollments due" };
    }

    logger.info("Found due enrollments", { count: enrollments.length });

    // ── 2. Fan out: trigger a step task per enrollment ───────────────
    const batchItems = enrollments.map((enrollment) => ({
      payload: {
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequence_id,
        candidateId: enrollment.candidate_id,
        contactId: enrollment.contact_id,
        currentStepOrder: enrollment.current_step_order,
        accountId: enrollment.account_id,
        enrolledBy: enrollment.enrolled_by,
        enrolledAt: enrollment.enrolled_at,
        stopOnReply: (enrollment.sequences as any)?.stop_on_reply,
        sequenceChannel: (enrollment.sequences as any)?.channel,
      },
    }));

    const batchResult = await processSequenceStep.batchTrigger(batchItems);

    logger.info("Sweep complete", {
      triggered: batchResult.runs.length,
      total: enrollments.length,
    });

    return {
      triggered: batchResult.runs.length,
      total: enrollments.length,
      timestamp: now.toISOString(),
    };
  },
});

/**
 * Scan recent executions with status 'sent' or 'delivered' and check
 * the messages table for open/reply signals.
 * Ported from process-sequence-emails updateTrackingStatuses()
 */
async function updateTrackingStatuses(supabase: any, now: Date) {
  try {
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const { data: executions, error } = await supabase
      .from("sequence_step_executions")
      .select(`
        id,
        enrollment_id,
        sequence_step_id,
        status,
        external_message_id,
        external_conversation_id,
        executed_at
      `)
      .in("status", ["sent", "delivered"])
      .gte("executed_at", cutoff.toISOString())
      .order("executed_at", { ascending: false })
      .limit(200);

    if (error || !executions || executions.length === 0) return;

    const enrollmentIds = [...new Set(executions.map((e: any) => e.enrollment_id))];
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id, contact_id")
      .in("id", enrollmentIds);

    const enrollmentMap = new Map((enrollments ?? []).map((e: any) => [e.id, e]));

    for (const exec of executions) {
      const enrollment = enrollmentMap.get(exec.enrollment_id);
      if (!enrollment) continue;

      const entityId = enrollment.candidate_id || enrollment.contact_id;
      const entityColumn = enrollment.candidate_id
        ? "candidate_id"
        : "contact_id";
      if (!entityId) continue;

      // Check for inbound reply after this execution
      const { data: replies } = await supabase
        .from("messages")
        .select("id")
        .eq(entityColumn, entityId)
        .eq("direction", "inbound")
        .gte("created_at", exec.executed_at)
        .limit(1);

      if (replies && replies.length > 0) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "replied" } as any)
          .eq("id", exec.id);
        continue;
      }

      // Check if conversation has been read (proxy for "opened")
      if (exec.external_conversation_id) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("is_read")
          .eq("external_conversation_id", exec.external_conversation_id)
          .maybeSingle();

        if (conv?.is_read && exec.status === "sent") {
          await supabase
            .from("sequence_step_executions")
            .update({ status: "opened" } as any)
            .eq("id", exec.id);
          continue;
        }
      }

      // If we have an external_message_id but status is still 'sent', mark delivered
      if (exec.status === "sent" && exec.external_message_id) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "delivered" } as any)
          .eq("id", exec.id);
      }
    }

    logger.info("Tracking update complete", { checked: executions.length });
  } catch (err) {
    logger.error("Tracking update error", { error: err });
  }
}
