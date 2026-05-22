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
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 25);

    // Lightweight relevance scorer: count how many of the user's tokens
    // appear in the row's most-relevant fields. Postgres ilike can't sort
    // multi-token relevance natively without a full-text index, so we
    // fetch a wider net (limit*4) and sort in JS.
    const scoreRow = (row: Record<string, any>, tokens: string[], fields: string[]) => {
      const haystack = fields.map((f) => String(row[f] ?? "")).join(" ").toLowerCase();
      return tokens.reduce((acc, t) => acc + (haystack.includes(t.toLowerCase()) ? 1 : 0), 0);
    };

    const candidates: any[] = [];
    if (typeof candidate_query === "string" && candidate_query.trim()) {
      const q = candidate_query.trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      const orClauses = tokens.flatMap((t) => [
        `first_name.ilike.%${t}%`,
        `last_name.ilike.%${t}%`,
        `current_company.ilike.%${t}%`,
      ]);
      orClauses.push(`linkedin_url.ilike.%${q}%`);
      // candidates is a view over people (already excludes soft-deleted),
      // so no .is('deleted_at', null) filter here.
      const { data, error } = await supabase
        .from("candidates")
        .select("id, first_name, last_name, current_title, current_company, linkedin_url, type, status, created_at")
        .or(orClauses.join(","))
        .eq("type", "candidate")
        .order("created_at", { ascending: false })
        .limit(limit * 4);
      if (error) {
        return res.status(500).json({ error: `candidate search failed: ${error.message}` });
      }
      const rows = data ?? [];
      rows.sort((a: any, b: any) =>
        scoreRow(b, tokens, ["first_name", "last_name", "current_company", "current_title"]) -
        scoreRow(a, tokens, ["first_name", "last_name", "current_company", "current_title"]),
      );
      candidates.push(...rows.slice(0, limit));
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
        .select("id, title, company_name, location, status, created_at")
        .or(orClauses.join(","))
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit * 4);
      if (error) {
        return res.status(500).json({ error: `job search failed: ${error.message}` });
      }
      const rows = data ?? [];
      rows.sort((a: any, b: any) =>
        scoreRow(b, tokens, ["title", "company_name"]) -
        scoreRow(a, tokens, ["title", "company_name"]),
      );
      jobs.push(...rows.slice(0, limit));
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
