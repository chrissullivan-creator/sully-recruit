import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/gpt/search-candidate-and-job
 *
 * Used by the Ask Joe Send-Out custom GPT to resolve a free-text query
 * ("Format Jane Doe for the Goldman MD role") into structured
 * candidate + job IDs the GPT can pass to fetch-sendout-context.
 *
 * Body:
 *   candidate_query  Free text — name, current company, or LinkedIn handle. Optional.
 *   job_query        Free text — job title, client company. Optional.
 *   limit            Cap on rows returned per side. Default 5, max 20.
 *
 * Auth: SUPABASE_SERVICE_ROLE_KEY bearer (used by the GPT Action) or a Supabase user JWT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { candidate_query, job_query } = req.body ?? {};
    const limit = Math.min(Math.max(Number(req.body?.limit) || 5, 1), 20);

    const candidates: any[] = [];
    if (typeof candidate_query === "string" && candidate_query.trim()) {
      const q = candidate_query.trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      // Match on first_name OR last_name OR current_company OR linkedin_url against any token.
      // ilike with '%token%' on multiple columns, OR'd together.
      const orClauses = tokens.flatMap((t) => [
        `first_name.ilike.%${t}%`,
        `last_name.ilike.%${t}%`,
        `current_company.ilike.%${t}%`,
      ]);
      // Also a coarse linkedin handle match (no token-split — match the whole query).
      orClauses.push(`linkedin_url.ilike.%${q}%`);
      const { data, error } = await supabase
        .from("candidates")
        .select("id, first_name, last_name, current_title, current_company, linkedin_url, type, status")
        .or(orClauses.join(","))
        .eq("type", "candidate")
        .limit(limit);
      if (error) {
        return res.status(500).json({ error: `candidate search failed: ${error.message}` });
      }
      candidates.push(...(data ?? []));
    }

    const jobs: any[] = [];
    if (typeof job_query === "string" && job_query.trim()) {
      const q = job_query.trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      const orClauses = tokens.flatMap((t) => [
        `title.ilike.%${t}%`,
        `company_name.ilike.%${t}%`,
      ]);
      const { data, error } = await supabase
        .from("jobs")
        .select("id, title, company_name, location, status")
        .or(orClauses.join(","))
        .limit(limit);
      if (error) {
        return res.status(500).json({ error: `job search failed: ${error.message}` });
      }
      jobs.push(...(data ?? []));
    }

    return res.status(200).json({
      candidates: candidates.map((c) => ({
        candidate_id: c.id,
        full_name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
        current_title: c.current_title || null,
        current_company: c.current_company || null,
        linkedin_url: c.linkedin_url || null,
        status: c.status || null,
      })),
      jobs: jobs.map((j) => ({
        job_id: j.id,
        title: j.title,
        company: j.company_name || null,
        location: j.location || null,
        status: j.status || null,
      })),
    });
  } catch (err: any) {
    console.error("gpt/search-candidate-and-job error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
