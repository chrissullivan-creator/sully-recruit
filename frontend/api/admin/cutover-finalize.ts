import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../lib/inngest/client.js";

/**
 * One-shot admin endpoint to finish the Trigger.dev → Inngest sequence
 * cutover from a single curl. Server-side use of `inngest.send` so we
 * don't depend on the operator having INNGEST_EVENT_KEY locally.
 *
 *   curl -X POST https://<vercel-app>/api/admin/cutover-finalize \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
 *
 * Steps the endpoint runs:
 *   1. UPDATE sequences SET engine='inngest' WHERE engine='trigger'
 *   2. Find every active enrollment with no open step_logs
 *      (no scheduled / pending_connection / in_flight)
 *   3. inngest.send('sequence/run.requested', …) per orphan, chunked
 *      at 500/call (Inngest send cap is 5000/req — 500 keeps the
 *      payload comfortably under the network buffer).
 *
 * Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>. We reuse the
 * service-role key as the admin token because (a) it's already in
 * Vercel env, (b) anyone who already has it has full DB access — no
 * security regression vs adding a new ADMIN_TOKEN env var.
 *
 * Idempotent: re-runs no-op once everything's flipped + dispatched.
 *
 * IMPORTANT: This endpoint dispatches `sequence/run.requested` events.
 * Production's sequence-run function is a Phase 1 no-op until PR #198
 * (real Inngest sequence engine) merges. Until then, this endpoint
 * fires events that get acknowledged + logged but produce no sends.
 * Once #198 is in, the same dispatch wakes the engine.
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
        id, sequence_id, enrolled_by,
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

    // ── Step 3: dispatch sequence/run.requested per orphan ──────────
    let dispatched = 0;
    if (orphans.length > 0) {
      const events = orphans.map((e) => ({
        // Distinct dedup key per cutover run so this rescue doesn't
        // suppress any earlier `seq-{enrollmentId}` events in Inngest's
        // log.
        id: `seq-run-${e.id}-cutover-${Math.floor(Date.now() / 1000)}`,
        name: "sequence/run.requested" as const,
        data: {
          enrollmentId: e.id as string,
          sequenceId: e.sequence_id as string,
          enrolledBy:
            (e.sequences?.sender_user_id as string | undefined)
            ?? (e.sequences?.created_by as string | undefined)
            ?? (e.enrolled_by as string),
        },
      }));
      const chunkSize = 500;
      for (let i = 0; i < events.length; i += chunkSize) {
        const chunk = events.slice(i, i + chunkSize);
        await inngest.send(chunk);
        dispatched += chunk.length;
      }
    }

    return res.status(200).json({
      ok: true,
      sequences_flipped: flipped.length,
      sequences_flipped_ids: flipped.map((s) => ({ id: s.id, name: s.name })),
      active_enrollments_total: allActive.length,
      orphan_enrollments_dispatched: dispatched,
      orphan_enrollment_ids_sample: orphans.slice(0, 10).map((e) => e.id as string),
      note:
        "If sequence-run is still Phase 1 no-op (PR #198 not merged), "
        + "the dispatched events get acknowledged but produce no sends. "
        + "Re-run this endpoint after #198 merges to wake them up.",
    });
  } catch (err: any) {
    console.error("cutover-finalize error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
