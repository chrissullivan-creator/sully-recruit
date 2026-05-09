import { inngest } from "../client";
import { getSupabaseAdmin } from "../../server/lib/supabase";

/**
 * Rescue function for the post-cutover gap. Finds every
 * `sequence_enrollments` row with status='active' that has NO open
 * step_logs (no scheduled, no pending_connection, no in_flight) and
 * fires `sequence/enrolled` for each so the Inngest sequence-run
 * function picks them up and pre-writes a fresh row of step_logs.
 *
 * This is what the operator needs to run AFTER manually flipping
 * sequences.engine='inngest' if the migrate-sequence-to-inngest
 * cutover dropped enrollments (e.g. its flip-engine step succeeded
 * but the re-enroll step crashed mid-batch).
 *
 * Trigger via:
 *   inngest.send({
 *     name: "infra/rescue-orphan-enrollments.requested",
 *     data: { enrolledBy?: "<operator-uuid>", limit?: 1000 },
 *   })
 *
 * Idempotent: re-firing this is a no-op once every active enrollment
 * has open step_logs. Active enrollments that already have at least
 * one open step_log are SKIPPED (so we don't create duplicate runs
 * for in-flight sequences).
 *
 * `enrolledBy` falls back to the sequence's sender_user_id /
 * created_by per-row when omitted.
 */
export const rescueOrphanEnrollments = inngest.createFunction(
  {
    id: "rescue-orphan-enrollments",
    retries: 1,
    triggers: [{ event: "infra/rescue-orphan-enrollments.requested" }],
    concurrency: [{ limit: 1 }],
  },
  async ({ event, step, logger }) => {
    const { enrolledBy: enrolledByInput, limit = 1000 } = (event.data ?? {}) as {
      enrolledBy?: string;
      limit?: number;
    };
    const supabase = getSupabaseAdmin();

    const orphans = await step.run("find-orphan-enrollments", async () => {
      // Pull every active enrollment with its sequence's sender info,
      // then filter in JS to those with no open step_logs. Doing this
      // in two queries because the join+anti-join is annoying via
      // PostgREST.
      const { data: enrollments } = await supabase
        .from("sequence_enrollments")
        .select(`
          id, sequence_id, candidate_id, contact_id, enrolled_by,
          sequences!inner(id, engine, sender_user_id, created_by)
        `)
        .eq("status", "active")
        .limit(limit);
      if (!enrollments || enrollments.length === 0) return [];

      const enrollmentIds = enrollments.map((e: any) => e.id);
      const { data: openLogs } = await supabase
        .from("sequence_step_logs")
        .select("enrollment_id")
        .in("enrollment_id", enrollmentIds)
        .in("status", ["scheduled", "pending_connection", "in_flight"]);
      const withOpen = new Set((openLogs || []).map((l: any) => l.enrollment_id));

      return enrollments.filter((e: any) => !withOpen.has(e.id));
    });

    if (orphans.length === 0) {
      logger.info("Rescue: no orphan active enrollments");
      return { dispatched: 0 };
    }

    await step.run("dispatch-sequence-enrolled", async () => {
      await inngest.send(
        orphans.map((e: any) => ({
          // Distinct dedup key so this re-enroll doesn't suppress the
          // original seq-enrolled-{enrollmentId} event from the Inngest
          // event log.
          id: `seq-enrolled-${e.id}-rescue-${Math.floor(Date.now() / 1000)}`,
          name: "sequence/enrolled",
          data: {
            enrollmentId: e.id,
            sequenceId: e.sequence_id,
            candidateId: e.candidate_id || undefined,
            contactId: e.contact_id || undefined,
            enrolledBy:
              enrolledByInput
              || e.sequences?.sender_user_id
              || e.sequences?.created_by
              || e.enrolled_by,
          },
        })),
      );
    });

    logger.info("Rescue dispatched", {
      dispatched: orphans.length,
      sample: orphans.slice(0, 5).map((e: any) => e.id),
    });

    return {
      dispatched: orphans.length,
      enrollmentIds: orphans.map((e: any) => e.id),
    };
  },
);
