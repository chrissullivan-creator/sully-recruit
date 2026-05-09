import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../../src/inngest/client";

/**
 * One-shot admin endpoint to finalise the Inngest cutover.
 *
 * Hand-rolled because the migrate-sequence-to-inngest function ran on
 * production but its flip-engine + re-enroll steps didn't fully take
 * effect. This endpoint:
 *
 *   1. UPDATE sequences SET engine='inngest' WHERE engine='trigger'
 *   2. Find every active enrollment with no open step_logs (no
 *      scheduled / pending_connection / in_flight)
 *   3. inngest.send('sequence/enrolled', …) for each — server-side,
 *      so it uses the Vercel-set INNGEST_EVENT_KEY automatically.
 *
 * Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *   We reuse the service role key as the admin token because (a) it's
 *   already set in Vercel env, (b) anyone who has it already has
 *   full DB access, so it's not weakening anything.
 *
 * Idempotent — re-runs are safe; rows that are already on engine=
 * 'inngest' or already have open step_logs are skipped.
 *
 * curl -X POST https://<vercel-app>/api/admin/cutover-finalize \
 *   -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
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
    const { data: flippedRows } = await supabase
      .from("sequences")
      .update({ engine: "inngest" } as any)
      .eq("engine", "trigger")
      .select("id, name");
    const flipped = flippedRows ?? [];

    // ── Step 2: find orphan active enrollments ──────────────────────
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select(`
        id, sequence_id, candidate_id, contact_id, enrolled_by,
        sequences!inner(id, sender_user_id, created_by)
      `)
      .eq("status", "active")
      .limit(2000);

    const allActive = enrollments ?? [];
    let orphans: any[] = [];
    if (allActive.length > 0) {
      const ids = allActive.map((e: any) => e.id);
      const { data: openLogs } = await supabase
        .from("sequence_step_logs")
        .select("enrollment_id")
        .in("enrollment_id", ids)
        .in("status", ["scheduled", "pending_connection", "in_flight"]);
      const withOpen = new Set((openLogs || []).map((l: any) => l.enrollment_id));
      orphans = allActive.filter((e: any) => !withOpen.has(e.id));
    }

    // ── Step 3: dispatch sequence/enrolled per orphan ────────────────
    let dispatched = 0;
    if (orphans.length > 0) {
      const events = orphans.map((e: any) => ({
        // Distinct dedup key so this rescue doesn't suppress the
        // original seq-enrolled-{enrollmentId} event in the Inngest log.
        id: `seq-enrolled-${e.id}-cutover-${Math.floor(Date.now() / 1000)}`,
        name: "sequence/enrolled",
        data: {
          enrollmentId: e.id,
          sequenceId: e.sequence_id,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy:
            e.sequences?.sender_user_id
            || e.sequences?.created_by
            || e.enrolled_by,
        },
      }));
      // inngest.send accepts arrays of up to 5000 events per call.
      // Chunk just in case the population grows.
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
      sequences_flipped_ids: flipped.map((s: any) => ({ id: s.id, name: s.name })),
      active_enrollments_total: allActive.length,
      orphan_enrollments_dispatched: dispatched,
      orphan_enrollment_ids_sample: orphans.slice(0, 10).map((e: any) => e.id),
    });
  } catch (err: any) {
    console.error("cutover-finalize error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
