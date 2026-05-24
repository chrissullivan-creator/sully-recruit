import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/enrichment-jobs/{id}
 *
 * Poll endpoint for the async enrich path. The EnrichButton hits this
 * every few seconds while a job is queued/running and stops once
 * status flips to completed or failed.
 *
 * Returns the public-safe subset of the row (no full results blob
 * unless the caller asks for ?include=results — keeps the polling
 * payload small).
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
  }

  const id = String(req.query.id || "");
  if (!id) return res.status(400).json({ error: "id required" });

  const includeResults = req.query.include === "results";
  const cols = includeResults
    ? "id, status, total, processed, changed, failed, credits, linkedin_summary, results, error, started_at, finished_at, created_at"
    : "id, status, total, processed, changed, failed, credits, linkedin_summary, error, started_at, finished_at, created_at";

  const { data, error } = await supabase
    .from("enrichment_jobs")
    .select(cols)
    .eq("id", id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "job not found" });

  return res.status(200).json(data);
}
