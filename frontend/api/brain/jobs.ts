import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/jobs
 *
 * Search open jobs by title / company / location / status.
 *
 * Body: { query?: string, status?: string, limit?: number (default 15, max 50) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const query = String(req.body?.query ?? "").trim();
  const status = typeof req.body?.status === "string" ? req.body.status : null;
  const limit = Math.min(Math.max(Number(req.body?.limit) || 15, 1), 50);

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let q = supabase
    .from("jobs")
    .select("id, title, company_name, location, status, compensation, job_code, num_openings, created_at, updated_at, last_sourced_at")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (query) {
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
    const orFilter = tokens
      .flatMap((t) => [`title.ilike.%${t}%`, `company_name.ilike.%${t}%`, `location.ilike.%${t}%`])
      .join(",");
    q = q.or(orFilter);
  }
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ query, status, count: data?.length ?? 0, jobs: data ?? [] });
}
