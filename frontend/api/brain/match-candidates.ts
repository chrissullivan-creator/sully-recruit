import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";
import { embedQuery } from "../lib/voyage.js";

/**
 * POST /api/brain/match-candidates
 *
 * Rank candidates from the DB against a job. Either pass `job_id` (uses
 * the stored job description) or pass an ad-hoc `description` + `title`.
 * Returns the top N with similarity scores so the GPT can write up the
 * rationale itself — non-streaming JSON (Custom GPT Actions don't do SSE).
 *
 * Body: {
 *   job_id?: string,
 *   title?: string,
 *   company?: string,
 *   description?: string,
 *   location?: string,
 *   compensation?: string,
 *   limit?: number (default 15, max 50)
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const limit = Math.min(Math.max(Number(req.body?.limit) || 15, 1), 50);
  const jobId = typeof req.body?.job_id === "string" ? req.body.job_id.trim() : "";

  let title = String(req.body?.title ?? "").trim();
  let company = String(req.body?.company ?? "").trim();
  let description = String(req.body?.description ?? "").trim();
  let location = String(req.body?.location ?? "").trim();
  let compensation = String(req.body?.compensation ?? "").trim();

  if (jobId) {
    const { data: job, error } = await supabase
      .from("jobs")
      .select("title, company_name, description, location, compensation")
      .eq("id", jobId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!job) return res.status(404).json({ error: "job not found", job_id: jobId });
    title = title || job.title || "";
    company = company || job.company_name || "";
    description = description || job.description || "";
    location = location || job.location || "";
    compensation = compensation || job.compensation || "";
  }

  if (!title && !description) {
    return res.status(400).json({ error: "job_id or (title + description) required" });
  }

  const searchText = [title, company, location, compensation, description.slice(0, 3000)]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 4000);

  let embedding: number[];
  try {
    embedding = await embedQuery(searchText);
  } catch (err: any) {
    return res.status(500).json({ error: `embedding failed: ${err?.message ?? "unknown"}` });
  }

  const { data: matches, error: matchErr } = await supabase.rpc("match_candidates_for_job", {
    query_embedding: embedding,
    match_count: limit * 3,
  });
  if (matchErr) return res.status(500).json({ error: `match RPC: ${matchErr.message}` });

  const dedupedIds = Array.from(
    new Set(((matches as any[]) ?? []).map((m) => m.candidate_id).filter(Boolean)),
  ).slice(0, limit * 2);

  if (dedupedIds.length === 0) {
    return res.status(200).json({
      job: { id: jobId || null, title, company, location, compensation },
      count: 0,
      candidates: [],
      note: "no candidate vector matches — try keyword search via /api/brain/search",
    });
  }

  const { data: people, error: peopleErr } = await supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location_text, status, email, mobile_phone, linkedin_url, target_base_comp, target_total_comp, visa_status, last_contacted_at, last_responded_at, joe_says, roles",
    )
    .in("id", dedupedIds)
    .contains("roles", ["candidate"]);
  if (peopleErr) return res.status(500).json({ error: `enrich: ${peopleErr.message}` });

  const simById = new Map<string, number>();
  for (const m of (matches as any[]) ?? []) {
    if (!m.candidate_id) continue;
    const prev = simById.get(m.candidate_id) ?? 0;
    if (m.similarity > prev) simById.set(m.candidate_id, m.similarity);
  }

  const ranked = ((people as any[]) ?? [])
    .map((p) => ({
      candidate_id: p.id,
      full_name: p.full_name,
      current_title: p.current_title,
      current_company: p.current_company,
      location: p.location_text,
      status: p.status,
      email: p.email,
      phone: p.mobile_phone,
      linkedin_url: p.linkedin_url,
      target_base_comp: p.target_base_comp,
      target_total_comp: p.target_total_comp,
      visa_status: p.visa_status,
      last_contacted_at: p.last_contacted_at,
      last_responded_at: p.last_responded_at,
      joe_says_excerpt: typeof p.joe_says === "string" ? p.joe_says.slice(0, 600) : null,
      similarity: Number((simById.get(p.id) ?? 0).toFixed(4)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return res.status(200).json({
    job: { id: jobId || null, title, company, location, compensation },
    count: ranked.length,
    candidates: ranked,
  });
}
