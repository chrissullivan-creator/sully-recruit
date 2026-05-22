import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Safety-net sweep for the enrollment → init hand-off.
 *
 * `/api/trigger-sequence-enroll` calls into `sequenceEnrollmentInit`
 * (Inngest, post-PR-#200) right after inserting each
 * `sequence_enrollments` row. If that hand-off fails (network blip,
 * endpoint not deployed, the dialog's older code that didn't call it
 * at all) the enrollment sits dormant: the schedule view shows
 * "No scheduled sends" forever and no email/LinkedIn ever fires.
 *
 * This sweep finds active enrollments older than 5 minutes with zero
 * step_logs and fires `sequence/enrollment-init.requested` per row.
 * The init function is idempotent on the enrollment id (early-returns
 * when status isn't 'active') and uses concurrency keyed on
 * enrollmentId, so re-runs are safe.
 *
 * Every 10 minutes. Ported from `src/trigger/backfill-enrollment-init.ts`
 * — Inngest is the only scheduler now.
 */
export const backfillEnrollmentInit = inngest.createFunction(
  { id: "backfill-enrollment-init", name: "Backfill stuck enrollment init (Inngest)" },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: candidates, error: enrollErr } = await supabase
      .from("sequence_enrollments")
      .select("id, sequence_id, candidate_id, contact_id, enrolled_by")
      .eq("status", "active")
      .lt("enrolled_at", fiveMinAgo)
      .order("enrolled_at", { ascending: true })
      .limit(200);

    if (enrollErr) {
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

    const tsSec = Math.floor(Date.now() / 1000);
    const events = stuck.map((e) => ({
      // Distinct id per backfill run — matches the cutover-finalize
      // pattern so a fresh sweep doesn't get suppressed by a dedup
      // collision on the original `enrollment-init-{id}` event.
      id: `enrollment-init-${e.id}-backfill-${tsSec}`,
      name: "sequence/enrollment-init.requested" as const,
      data: {
        enrollmentId: e.id,
        sequenceId: e.sequence_id,
        candidateId: e.candidate_id || undefined,
        contactId: e.contact_id || undefined,
        enrolledBy: e.enrolled_by,
      },
    }));

    // Inngest's send accepts up to 5000 events per call; chunk at 500
    // to stay under the network buffer.
    let triggered = 0;
    const chunkSize = 500;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      try {
        await inngest.send(chunk);
        triggered += chunk.length;
      } catch (err: any) {
        logger.warn("Init dispatch chunk failed", { chunkSize: chunk.length, error: err.message });
      }
    }

    return { triggered, scanned: list.length, stuck: stuck.length };
  },
);
