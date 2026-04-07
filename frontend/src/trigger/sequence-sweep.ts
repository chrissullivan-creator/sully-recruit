import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { processSequenceStep } from "./sequence-step";

/**
 * Sequence sweep — runs every 5 minutes.
 *
 * Picks up the 3 oldest due enrollments from active sequences,
 * then fans out to per-enrollment step tasks. The small batch size
 * combined with per-send jitter keeps throughput human-paced
 * (~1 send every 2-5 min).
 *
 * Tracking updates (opened, replied, bounced) are handled by the
 * webhook handlers — NOT in the sweep.
 */
export const sequenceSweep = schedules.task({
  id: "sequence-sweep",
  cron: "*/5 * * * *",
  run: async () => {
    const supabase = getSupabaseAdmin();
    const now = new Date();

    logger.info("Sequence sweep started", { timestamp: now.toISOString() });

    // Fetch active enrollments that are due, from active sequences only
    const { data: enrollments, error } = await supabase
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
          channel,
          status
        )
      `)
      .eq("status", "active")
      .eq("sequences.status", "active")
      .lte("next_step_at", now.toISOString())
      .order("next_step_at", { ascending: true })
      .limit(1);

    if (error) {
      logger.error("Error fetching enrollments", { error });
      throw error;
    }

    if (!enrollments || enrollments.length === 0) {
      logger.info("No enrollments due");
      return { processed: 0 };
    }

    logger.info("Found due enrollments", { count: enrollments.length });

    // Fan out: one step-execution task per enrollment
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
        stopOnReply: (enrollment.sequences as any)?.stop_on_reply ?? true,
        sequenceChannel: (enrollment.sequences as any)?.channel ?? "email",
      },
    }));

    const result = await processSequenceStep.batchTrigger(batchItems);

    logger.info("Sweep complete", {
      triggered: result.runs.length,
      total: enrollments.length,
    });

    return {
      triggered: result.runs.length,
      total: enrollments.length,
      timestamp: now.toISOString(),
    };
  },
});
