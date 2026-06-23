import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Safety-net sweep for the enrollment → init hand-off.
 *
 * `/api/trigger-sequence-enroll` (and the BD-sequence / bulk paths) call
 * `sequenceEnrollmentInit` right after inserting each `sequence_enrollments`
 * row. If that hand-off fails (network blip, endpoint not deployed) the
 * enrollment sits dormant: the schedule view shows "No scheduled sends" and
 * nothing ever fires.
 *
 * Two cases are healed here, both identified by "zero step_logs":
 *   1. ACTIVE enrollments older than 5 min — the classic hand-off-failed case.
 *   2. PAUSED enrollments whose SEQUENCE is active — an orphaned draft
 *      enrollment (e.g. a BD sequence drafted with its contacts attached, then
 *      activated without promoting them). These are promoted to active and
 *      initialised so they actually start. A paused enrollment that already has
 *      step_logs was deliberately paused mid-flight and is left untouched.
 *
 * The init function is idempotent on the enrollment id (early-returns when
 * status isn't 'active', skips actions that already have a live step_log) and
 * uses concurrency keyed on enrollmentId, so re-runs are safe.
 *
 * Every 10 minutes. Inngest is the only scheduler.
 */
export const backfillEnrollmentInit = inngest.createFunction(
  { id: "backfill-enrollment-init", name: "Backfill stuck enrollment init (Inngest)" },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // (1) Active enrollments past the grace window.
    const { data: activeRows, error: enrollErr } = await supabase
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

    // (2) Paused enrollments whose sequence is active — orphaned drafts that
    // were activated without promotion. Promoted + initialised below.
    const { data: pausedRows, error: pausedErr } = await supabase
      .from("sequence_enrollments")
      .select("id, sequence_id, candidate_id, contact_id, enrolled_by, sequences!inner(status)")
      .eq("status", "paused")
      .eq("sequences.status", "active")
      .limit(200);
    if (pausedErr) logger.warn("paused-on-active query failed", { error: pausedErr.message });

    const pausedIds = new Set(((pausedRows ?? []) as any[]).map((e) => e.id));
    const byId = new Map<string, any>();
    for (const e of [...((activeRows ?? []) as any[]), ...((pausedRows ?? []) as any[])]) byId.set(e.id, e);
    const list = [...byId.values()];
    if (list.length === 0) {
      logger.info("No enrollments to check");
      return { triggered: 0 };
    }

    // Only enrollments with ZERO step_logs are stuck (never initialised).
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

    // Promote stuck paused enrollments to active so init will run (it
    // early-returns unless status='active'). sequence_enrollments has no
    // updated_at column.
    const toPromote = stuck.filter((e) => pausedIds.has(e.id)).map((e) => e.id);
    if (toPromote.length) {
      const { error: promErr } = await supabase
        .from("sequence_enrollments")
        .update({ status: "active" } as any)
        .in("id", toPromote);
      if (promErr) logger.warn("promote paused→active failed", { error: promErr.message });
    }

    logger.warn("Found stuck enrollments — triggering init", {
      stuck_count: stuck.length,
      promoted: toPromote.length,
      example_ids: stuck.slice(0, 3).map((e) => e.id),
    });

    const tsSec = Math.floor(Date.now() / 1000);
    // Stagger so a backlog of stuck enrollments doesn't fire near-identical
    // times (each ~5–12 min after the previous).
    let cumStagger = 0;
    const events = stuck.map((e) => {
      const staggerMinutes = cumStagger;
      cumStagger += 5 + Math.floor(Math.random() * 8);
      return {
        // Distinct id per backfill run so a fresh sweep isn't suppressed by a
        // dedup collision on the original `enrollment-init-{id}` event.
        id: `enrollment-init-${e.id}-backfill-${tsSec}`,
        name: "sequence/enrollment-init.requested" as const,
        data: {
          enrollmentId: e.id,
          sequenceId: e.sequence_id,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy: e.enrolled_by,
          staggerMinutes,
        },
      };
    });

    // Inngest's send accepts up to 5000 events per call; chunk at 500.
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

    return { triggered, scanned: list.length, stuck: stuck.length, promoted: toPromote.length };
  },
);
