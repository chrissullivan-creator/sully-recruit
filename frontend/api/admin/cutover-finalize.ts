import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * One-shot admin endpoint to finish the Trigger.dev → Inngest sequence
 * cutover from a single curl.
 *
 *   curl -X POST https://<vercel-app>/api/admin/cutover-finalize \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
 *
 * Steps the endpoint runs:
 *   1. UPDATE sequences SET engine='inngest' WHERE engine='trigger'
 *   2. Find every active enrollment with no open step_logs
 *      (no scheduled / pending_connection / in_flight)
 *   3. For each orphan: tasks.trigger("sequence-enrollment-init", …)
 *      so its sequence_actions get pre-materialised into fresh
 *      scheduled step_logs. The Inngest sweep (post-#198) then picks
 *      them up on the next 3-min tick since the sequence is on
 *      engine='inngest'.
 *
 * Why tasks.trigger and not inngest.send: PR #198 keeps
 * sequenceEnrollmentInit on Trigger.dev (it pre-materialises step_logs
 * for both engines). Inngest only owns the sweep + per-action
 * execution post-cutover. Firing a `sequence/...` Inngest event for
 * orphans wouldn't reach a handler — there's no per-enrollment
 * Inngest function in the new architecture.
 *
 * Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>. Reuses an
 * existing Vercel env var — no new ADMIN_TOKEN setup. Anyone who
 * already has this key already has full DB access — no security
 * regression vs adding a new env var.
 *
 * Idempotent — re-runs no-op once everything's flipped + re-initialised.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" });
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // ── Step 1: flip every sequence still on engine='trigger' ───────
    // engine column was added in migration 20260509000000; cast until
    // the weekly types-regen workflow catches up.
    const { data: flippedRows } = await (supabase as any)
      .from("sequences")
      .update({ engine: "inngest" })
      .eq("engine", "trigger")
      .select("id, name");
    const flipped = (flippedRows ?? []) as Array<{ id: string; name: string }>;

    // ── Step 2: find orphan active enrollments ──────────────────────
    const { data: enrollmentRows } = await (supabase as any)
      .from("sequence_enrollments")
      .select(`
        id, sequence_id, candidate_id, contact_id, enrolled_by,
        sequences!inner(id, sender_user_id, created_by)
      `)
      .eq("status", "active")
      .limit(2000);
    const allActive = (enrollmentRows ?? []) as Array<any>;

    let orphans: Array<any> = [];
    if (allActive.length > 0) {
      const ids = allActive.map((e) => e.id);
      const { data: openLogs } = await supabase
        .from("sequence_step_logs")
        .select("enrollment_id")
        .in("enrollment_id", ids)
        .in("status", ["scheduled", "pending_connection", "in_flight"]);
      const withOpen = new Set(((openLogs ?? []) as Array<any>).map((l) => l.enrollment_id));
      orphans = allActive.filter((e) => !withOpen.has(e.id));
    }

    // ── Step 3: re-init each orphan via Trigger.dev ─────────────────
    // Trigger.dev's SDK is still in package.json (PR #198 didn't drop
    // it). sequenceEnrollmentInit pre-materialises sequence_step_logs
    // for the enrollment regardless of engine, after which the Inngest
    // sweep claims them on the next tick.
    let dispatched = 0;
    const dispatchErrors: Array<{ enrollmentId: string; error: string }> = [];
    for (const e of orphans) {
      try {
        await tasks.trigger("sequence-enrollment-init", {
          enrollmentId: e.id as string,
          sequenceId: e.sequence_id as string,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy:
            (e.sequences?.sender_user_id as string | undefined)
            ?? (e.sequences?.created_by as string | undefined)
            ?? (e.enrolled_by as string),
        });
        dispatched++;
      } catch (err: any) {
        dispatchErrors.push({
          enrollmentId: e.id as string,
          error: err?.message || "unknown",
        });
      }
    }

    return res.status(200).json({
      ok: true,
      sequences_flipped: flipped.length,
      sequences_flipped_ids: flipped.map((s) => ({ id: s.id, name: s.name })),
      active_enrollments_total: allActive.length,
      orphan_enrollments_dispatched: dispatched,
      orphan_enrollment_ids_sample: orphans.slice(0, 10).map((e) => e.id as string),
      dispatch_errors_count: dispatchErrors.length,
      dispatch_errors_sample: dispatchErrors.slice(0, 5),
    });
  } catch (err: any) {
    console.error("cutover-finalize error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
