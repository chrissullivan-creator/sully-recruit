import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/tag-candidate-job
 *
 * Tags a person to a job by creating a `candidate_jobs` link (the CRM pipeline
 * association). Used by the Chrome extension's "tag person → job" action and
 * anywhere a lightweight job tag is needed. Idempotent on (candidate_id, job_id).
 *
 * Auth: Bearer Supabase JWT (or service-role).
 * Body: { candidate_id (required), job_id (required), pipeline_stage? = 'new' }
 * Returns: { ok: true, candidate_job_id, duplicate? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const { candidate_id, job_id, pipeline_stage } = req.body || {};
  if (!candidate_id || !job_id) {
    return res.status(400).json({ error: "candidate_id and job_id are required" });
  }
  const stage = (typeof pipeline_stage === "string" && pipeline_stage.trim()) || "new";

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Idempotent: one link per (candidate, job).
    const { data: existing } = await supabase
      .from("candidate_jobs")
      .select("id")
      .eq("candidate_id", candidate_id)
      .eq("job_id", job_id)
      .maybeSingle();
    if (existing?.id) {
      return res.status(200).json({ ok: true, candidate_job_id: existing.id, duplicate: true });
    }

    const { data: row, error } = await supabase
      .from("candidate_jobs")
      .insert({ candidate_id, job_id, pipeline_stage: stage } as any)
      .select("id")
      .single();
    if (error) throw error;

    return res.status(200).json({ ok: true, candidate_job_id: row?.id });
  } catch (err: any) {
    console.error("tag-candidate-job error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to tag candidate to job" });
  }
}
