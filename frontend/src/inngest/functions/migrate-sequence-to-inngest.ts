import { inngest } from "../client";
import { getSupabaseAdmin } from "../../trigger/lib/supabase";

/**
 * Operator-triggered migration: flip a single sequence from
 * engine='trigger' to engine='inngest' and re-enroll its active rows
 * onto the Inngest engine.
 *
 * Steps:
 *   1. Pause the sequence so the Trigger.dev sweep stops dispatching
 *      new actions for it.
 *   2. Cancel pending Trigger.dev step_logs (status = 'scheduled' or
 *      'pending_connection') for active enrollments. Sent / skipped /
 *      failed history is preserved for analytics.
 *   3. Flip sequences.engine = 'inngest'.
 *   4. Resume the sequence.
 *   5. Fan out one `sequence/enrolled` Inngest event per active
 *      enrollment. The Inngest sequence-run picks up each one and
 *      pre-writes a fresh row of step_logs starting from now.
 *
 * Idempotent: re-firing this for a sequence already on engine='inngest'
 * still cancels stragglers + re-enrolls, which is also the right shape
 * for "I broke things, please rerun the migration."
 *
 * Trigger via:
 *   inngest.send({
 *     name: "sequence/migrate-to-inngest.requested",
 *     data: { sequenceId, enrolledBy }
 *   })
 *
 * `enrolledBy` is the user_id to attribute the new runs to (typically
 * the operator running the cutover). Falls back to the sequence's
 * created_by.
 */
export const migrateSequenceToInngest = inngest.createFunction(
  {
    id: "migrate-sequence-to-inngest",
    retries: 1,
    triggers: [{ event: "sequence/migrate-to-inngest.requested" }],
    // One migration at a time per sequence. Concurrent migrations
    // could double-enroll the same row.
    concurrency: [{ key: "event.data.sequenceId", limit: 1 }],
  },
  async ({ event, step, logger }) => {
    const { sequenceId, enrolledBy: enrolledByInput } = event.data as {
      sequenceId: string;
      enrolledBy?: string;
    };
    if (!sequenceId) {
      return { skipped: true, reason: "missing_sequenceId" };
    }
    const supabase = getSupabaseAdmin();

    const seq = await step.run("load-sequence", async () => {
      const { data } = await supabase
        .from("sequences")
        .select("id, engine, status, created_by, sender_user_id")
        .eq("id", sequenceId)
        .maybeSingle();
      return data;
    });
    if (!seq) {
      return { skipped: true, reason: "sequence_not_found", sequenceId };
    }
    const enrolledBy = enrolledByInput || (seq as any).sender_user_id || (seq as any).created_by;

    const enrollments = await step.run("load-active-enrollments", async () => {
      const { data } = await supabase
        .from("sequence_enrollments")
        .select("id, candidate_id, contact_id")
        .eq("sequence_id", sequenceId)
        .eq("status", "active");
      return data ?? [];
    });

    await step.run("pause-sequence", async () => {
      await supabase
        .from("sequences")
        .update({ status: "paused", updated_at: new Date().toISOString() } as any)
        .eq("id", sequenceId);
    });

    const cancelled = await step.run("cancel-pending-step-logs", async () => {
      if (enrollments.length === 0) return 0;
      const { count } = await supabase
        .from("sequence_step_logs")
        .update({
          status: "cancelled",
          skip_reason: "engine_migration",
          updated_at: new Date().toISOString(),
        } as any)
        .in("enrollment_id", enrollments.map((e: any) => e.id))
        .in("status", ["scheduled", "pending_connection"])
        .select("id", { count: "exact", head: true });
      return count ?? 0;
    });

    await step.run("flip-engine", async () => {
      await supabase
        .from("sequences")
        .update({ engine: "inngest", updated_at: new Date().toISOString() } as any)
        .eq("id", sequenceId);
    });

    await step.run("resume-sequence", async () => {
      await supabase
        .from("sequences")
        .update({ status: "active", updated_at: new Date().toISOString() } as any)
        .eq("id", sequenceId);
    });

    const reEnrolled = await step.run("re-enroll-on-inngest", async () => {
      if (enrollments.length === 0) return 0;
      await inngest.send(
        enrollments.map((e: any) => ({
          // Distinct dedup key per migration so the original
          // seq-enrolled-{enrollmentId} doesn't suppress this one.
          id: `seq-enrolled-${e.id}-migrate-${Math.floor(Date.now() / 1000)}`,
          name: "sequence/enrolled",
          data: {
            enrollmentId: e.id,
            sequenceId,
            candidateId: e.candidate_id || undefined,
            contactId: e.contact_id || undefined,
            enrolledBy,
          },
        })),
      );
      return enrollments.length;
    });

    logger.info("Sequence migrated to Inngest", {
      sequenceId,
      activeEnrollments: enrollments.length,
      cancelledStepLogs: cancelled,
      reEnrolled,
    });

    return {
      sequenceId,
      activeEnrollments: enrollments.length,
      cancelledStepLogs: cancelled,
      reEnrolled,
    };
  },
);
