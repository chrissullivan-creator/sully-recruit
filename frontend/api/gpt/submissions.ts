import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireGptAuth, handleCors } from "../lib/gpt-auth.js";

/**
 * POST /api/gpt/submissions
 *
 * Create or update a candidate↔job submission. One row per (candidate_id,
 * job_id) — matched manually here because the existing `submissions`
 * table doesn't yet enforce a unique constraint on that pair. Once the
 * migration in /gpt/README.md is applied, the lookup is still safe.
 *
 * Body:
 *   candidate_id          : uuid (required)
 *   job_id                : uuid (required)
 *   status                : 'draft'|'ready_to_submit'|'submitted'|
 *                           'client_review'|'interview'|'rejected'|
 *                           'withdrawn'|'placed'
 *   tags                  : string[]  (merged with existing, deduped)
 *   submission_writeup    : string (the recruiter write-up)
 *   formatted_resume_url  : string (URL to the tailored PDF if uploaded)
 *   submitted_by          : string label (e.g. "Ask Joe Send Outs Emerald")
 *   mark_submitted        : boolean — when true, sets submitted_at = now()
 *
 * Behavior:
 *   - Upsert by (candidate_id, job_id).
 *   - Never null-clobbers: a missing field leaves the existing value.
 *   - Tags are MERGED with the existing list, then deduped.
 *   - updated_at is always set to now().
 *
 * Schema note: this assumes the `submissions` table has been extended
 * with status / tags / submission_writeup / formatted_resume_url /
 * submitted_by_label columns (see /gpt/README.md). If you haven't run
 * that migration yet, calls will fail with a column-not-found error
 * from PostgREST — that's your signal to apply it.
 */

const TABLE = "submissions";
const ALLOWED_STATUSES = new Set([
  "draft",
  "ready_to_submit",
  "submitted",
  "client_review",
  "interview",
  "rejected",
  "withdrawn",
  "placed",
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireGptAuth(req, res)) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured: Supabase env vars missing" });
  }

  const body = (req.body || {}) as Record<string, any>;
  const candidate_id = String(body.candidate_id || "").trim();
  const job_id = String(body.job_id || "").trim();
  if (!candidate_id) return res.status(400).json({ error: "Missing candidate_id" });
  if (!job_id) return res.status(400).json({ error: "Missing job_id" });

  const status = typeof body.status === "string" ? body.status.trim() : undefined;
  if (status && !ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({
      error: `status must be one of: ${Array.from(ALLOWED_STATUSES).join(", ")}`,
    });
  }

  const tagsInput: string[] | undefined = Array.isArray(body.tags)
    ? body.tags.filter((t: any) => typeof t === "string" && t.trim()).map((t: string) => t.trim())
    : undefined;
  const submission_writeup =
    typeof body.submission_writeup === "string" ? body.submission_writeup : undefined;
  const formatted_resume_url =
    typeof body.formatted_resume_url === "string" ? body.formatted_resume_url : undefined;
  const submitted_by_label =
    typeof body.submitted_by === "string" ? body.submitted_by : undefined;
  const mark_submitted = Boolean(body.mark_submitted);

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Find existing row (manual upsert — works even before the unique
    // constraint migration in the README is applied).
    const { data: existing, error: findErr } = await supabase
      .from(TABLE)
      .select("*")
      .eq("candidate_id", candidate_id)
      .eq("job_id", job_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findErr) {
      return res.status(500).json({ error: `lookup failed: ${findErr.message}` });
    }

    const now = new Date().toISOString();

    // Merge tags: union of existing + new, deduped, case-preserved.
    let mergedTags: string[] | undefined;
    if (tagsInput) {
      const existingTags: string[] = Array.isArray(existing?.tags) ? existing!.tags : [];
      const seen = new Set<string>();
      mergedTags = [...existingTags, ...tagsInput].filter((t) => {
        const key = t.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Build patch — only include keys the caller actually sent so we
    // never null-clobber existing values.
    const patch: Record<string, any> = { updated_at: now };
    if (status !== undefined) patch.status = status;
    if (mergedTags !== undefined) patch.tags = mergedTags;
    if (submission_writeup !== undefined) patch.submission_writeup = submission_writeup;
    if (formatted_resume_url !== undefined) patch.formatted_resume_url = formatted_resume_url;
    if (submitted_by_label !== undefined) patch.submitted_by_label = submitted_by_label;
    if (mark_submitted) patch.submitted_at = now;

    let saved: any;
    if (existing) {
      const { data, error } = await supabase
        .from(TABLE)
        .update(patch)
        .eq("id", existing.id)
        .select("*")
        .maybeSingle();
      if (error) return res.status(500).json({ error: `update failed: ${error.message}` });
      saved = data;
    } else {
      const insertRow: Record<string, any> = {
        candidate_id,
        job_id,
        created_at: now,
        ...patch,
      };
      // Default status to 'draft' on first insert so the row is queryable.
      if (insertRow.status === undefined) insertRow.status = "draft";
      const { data, error } = await supabase
        .from(TABLE)
        .insert(insertRow)
        .select("*")
        .maybeSingle();
      if (error) return res.status(500).json({ error: `insert failed: ${error.message}` });
      saved = data;
    }

    return res.status(200).json({ submission: saved });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Save failed" });
  }
}
