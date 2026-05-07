import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { sequenceEnrollmentInit } from "./sequence-scheduler";
import { notifyError } from "./lib/alerting";

/**
 * Safety-net sweep for the enrollment → init hand-off.
 *
 * The Enroll dialog calls /api/trigger-sequence-enroll after inserting
 * each `sequence_enrollments` row — that's the call that fans out to
 * sequenceEnrollmentInit and pre-schedules every step's
 * sequence_step_logs entry. If that hand-off fails (network blip,
 * endpoint not deployed, the dialog's older code that didn't call it
 * at all) the enrollment sits dormant: the schedule view shows
 * "No scheduled sends" forever and no email/LinkedIn ever fires.
 *
 * This sweep finds any active enrollment that's older than 5 minutes
 * with zero step logs and triggers the init task for it. The init
 * task is idempotent on the enrollment id (early-returns when status
 * isn't 'active'), so re-runs are safe.
 *
 * Runs every 10 minutes.
 */
export const backfillEnrollmentInit = schedules.task({
  id: "backfill-enrollment-init",
  cron: "*/10 * * * *",
  maxDuration: 300,
  run: async () => {
    const supabase = getSupabaseAdmin();

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Pull active enrollments older than the grace window.
    const { data: candidates, error: enrollErr } = await supabase
      .from("sequence_enrollments")
      .select("id, sequence_id, candidate_id, contact_id, enrolled_by")
      .eq("status", "active")
      .lt("enrolled_at", fiveMinAgo)
      .order("enrolled_at", { ascending: true })
      .limit(200);

    if (enrollErr) {
      // PostgREST errors are plain objects, not Error instances; pass
      // the message string explicitly so notifyError doesn't render
      // [object Object] in the alert.
      await notifyError({
        taskId: "backfill-enrollment-init",
        error: new Error(`enrollments_query: ${enrollErr.message ?? JSON.stringify(enrollErr)}`),
        context: { phase: "enrollments_query", details: enrollErr.details, hint: enrollErr.hint },
      });
      return { error: enrollErr.message };
    }
    const list = (candidates ?? []) as any[];
    if (list.length === 0) {
      logger.info("No enrollments older than grace window");
      return { triggered: 0 };
    }

    // Find which of them have ANY step logs. Single batched query.
    const ids = list.map((e) => e.id);
    const { data: hasLogs } = await supabase
      .from("sequence_step_logs")
      .select("enrollment_id")
      .in("enrollment_id", ids);
    const initialised = new Set((hasLogs ?? []).map((r: any) => r.enrollment_id));
    const stuck = list.filter((e) => !initialised.has(e.id));

    if (stuck.length === 0) {
      logger.info("All recent enrollments already initialised", { scanned: list.length });
      return { triggered: 0, scanned: list.length };
    }

    logger.warn("Found stuck enrollments — triggering init", {
      stuck_count: stuck.length,
      example_ids: stuck.slice(0, 3).map((e) => e.id),
    });

    let triggered = 0;
    for (const e of stuck) {
      try {
        await sequenceEnrollmentInit.trigger({
          enrollmentId: e.id,
          sequenceId: e.sequence_id,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy: e.enrolled_by,
        });
        triggered++;
      } catch (err: any) {
        logger.warn("Init trigger failed for enrollment", { enrollmentId: e.id, error: err.message });
      }
    }

    return { triggered, scanned: list.length, stuck: stuck.length };
  },
});
