import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth";

/**
 * POST /api/dedup/merge
 *
 * Merges a duplicate candidate into a survivor by calling the
 * `merge_duplicate_candidate` Postgres RPC. The RPC repoints FK
 * references, snapshots+deletes the merged row, and writes
 * candidate_merge_log.
 *
 * Body: { survivorId: string, mergedId: string, duplicatePairId?: string }
 * Auth: Supabase JWT (from logged-in user) or service role key.
 *
 * Note: previously this endpoint trigger.dev-fired a `merge-candidates`
 * task that no longer exists, which surfaced as
 *   "Task 'merge-candidates' not found on locked version 'YYYYMMDD.N'"
 * The merge is a synchronous DB op so calling the RPC directly is the
 * right shape — no queue indirection needed.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const { survivorId, mergedId, duplicatePairId } = req.body ?? {};

  if (!survivorId || !mergedId) {
    return res.status(400).json({ error: "Missing required fields: survivorId, mergedId" });
  }

  if (survivorId === mergedId) {
    return res.status(400).json({ error: "survivorId and mergedId must be different" });
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    const { data, error } = await supabase.rpc("merge_candidate", {
      p_survivor_id: survivorId,
      p_merged_id: mergedId,
    });
    if (error) {
      console.error("merge_candidate RPC error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    // duplicate_pair_id was previously passed to merge_duplicate_candidate
    // which marked the pair merged. merge_candidate handles that internally
    // by status-flipping any duplicate_candidates row referencing either id,
    // so no extra step is needed here.
    return res.status(200).json({ merged: true, result: data });
  } catch (err: any) {
    console.error("merge endpoint error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
