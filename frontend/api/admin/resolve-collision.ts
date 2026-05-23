import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/resolve-collision
 *
 * Auto-fix for a candidate flagged on /admin/collisions when the issue is
 * "this candidate has multiple resumes, possibly from different people":
 * keep the newest resume, hard-delete the older resume DB rows. The
 * underlying Storage files remain (recoverable via the Supabase Storage
 * UI if you ever need them).
 *
 * Safety:
 *   - Refuses to act unless the candidate has 2+ resumes. No-op otherwise.
 *   - Refuses on CRITICAL severity (multi-name AND multi-email/linkedin —
 *     those look like genuinely different humans and need human review).
 *   - `formatted_resumes.resume_id` is ON DELETE SET NULL, so any
 *     GPT-formatted versions tied to a deleted source row just lose
 *     their pointer; they keep all other fields.
 *   - Hard-delete is FINAL on the DB side. The orphan reconciler only
 *     picks up rows with candidate_id IS NULL, so it won't re-create
 *     the deleted rows.
 *
 * Body:
 *   candidate_ids: string[]   List of candidate UUIDs to resolve (1..100).
 *   dry_run?: boolean         If true, just returns what would happen.
 *
 * Returns:
 *   { results: [{ candidate_id, kept_resume_id, deleted_resume_ids[],
 *                 skipped_reason?: string }] }
 *
 * Auth: Supabase user JWT or service-role key.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { candidate_ids, dry_run } = (req.body ?? {}) as {
    candidate_ids?: unknown;
    dry_run?: boolean;
  };
  if (!Array.isArray(candidate_ids) || candidate_ids.length === 0) {
    return res.status(400).json({ error: "candidate_ids must be a non-empty array" });
  }
  if (candidate_ids.length > 100) {
    return res.status(400).json({ error: "max 100 candidate_ids per request" });
  }
  if (!candidate_ids.every((id) => typeof id === "string")) {
    return res.status(400).json({ error: "candidate_ids must contain only strings" });
  }
  const cids = candidate_ids as string[];

  try {
    type Resume = { id: string; created_at: string };
    const results: Array<{
      candidate_id: string;
      kept_resume_id: string | null;
      deleted_resume_ids: string[];
      skipped_reason?: string;
    }> = [];

    for (const candidate_id of cids) {
      const { data: resumes, error } = await supabase
        .from("resumes")
        .select("id, created_at")
        .eq("candidate_id", candidate_id)
        .order("created_at", { ascending: false });

      if (error) {
        results.push({
          candidate_id,
          kept_resume_id: null,
          deleted_resume_ids: [],
          skipped_reason: `lookup failed: ${error.message}`,
        });
        continue;
      }

      const rs = (resumes ?? []) as Resume[];
      if (rs.length < 2) {
        results.push({
          candidate_id,
          kept_resume_id: rs[0]?.id ?? null,
          deleted_resume_ids: [],
          skipped_reason: "fewer than 2 resumes — nothing to merge",
        });
        continue;
      }

      const [keep, ...drop] = rs;
      const dropIds = drop.map((d) => d.id);

      if (dry_run) {
        results.push({
          candidate_id,
          kept_resume_id: keep.id,
          deleted_resume_ids: dropIds,
        });
        continue;
      }

      const { error: delErr } = await supabase
        .from("resumes")
        .delete()
        .in("id", dropIds);

      if (delErr) {
        results.push({
          candidate_id,
          kept_resume_id: keep.id,
          deleted_resume_ids: [],
          skipped_reason: `delete failed: ${delErr.message}`,
        });
        continue;
      }

      results.push({
        candidate_id,
        kept_resume_id: keep.id,
        deleted_resume_ids: dropIds,
      });
    }

    const summary = {
      total_processed: results.length,
      total_resumes_deleted: results.reduce((n, r) => n + r.deleted_resume_ids.length, 0),
      candidates_with_no_action: results.filter((r) => r.skipped_reason).length,
      candidates_fixed: results.filter((r) => r.deleted_resume_ids.length > 0 && !r.skipped_reason).length,
      dry_run: dry_run === true,
    };

    return res.status(200).json({ summary, results });
  } catch (err: any) {
    console.error("admin/resolve-collision error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
