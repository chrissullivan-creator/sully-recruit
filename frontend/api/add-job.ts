import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/add-job
 *
 * Creates a job from a LinkedIn job posting — used by the Chrome extension's
 * "Add Job" action. Stored as a lead. Best-effort links to an existing company
 * by name so the job rolls up correctly.
 *
 * Auth: Bearer Supabase JWT (logged-in recruiter) or service-role key.
 * Body: { title (required), company?, company_name?, location?, description?,
 *         linkedin_url?, num_openings? }
 * Returns: { ok: true, job_id } or { ok: true, job_id, duplicate: true } when
 *          a job with the same LinkedIn URL already exists.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const {
    title,
    company = null,
    company_name = null,
    location = null,
    description = null,
    linkedin_url = null,
    num_openings = null,
  } = req.body || {};

  const jobTitle = String(title || "").trim();
  if (!jobTitle) return res.status(400).json({ error: "title is required" });

  const supabase = createClient(supabaseUrl, serviceKey);
  const jobUrl = linkedin_url ? String(linkedin_url).trim() : null;

  try {
    // De-dupe on the LinkedIn job URL so re-clicking "Add Job" doesn't pile up
    // duplicate leads.
    if (jobUrl) {
      const { data: existing } = await supabase
        .from("jobs")
        .select("id")
        .eq("job_url", jobUrl)
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        return res.status(200).json({ ok: true, job_id: existing.id, duplicate: true });
      }
    }

    const companyText = (company || company_name || "").toString().trim() || null;

    // Best-effort: link to an existing company by name.
    let companyId: string | null = null;
    if (companyText) {
      const { data: co } = await supabase
        .from("companies")
        .select("id")
        .ilike("name", companyText)
        .limit(1)
        .maybeSingle();
      companyId = co?.id ?? null;
    }

    const { data: job, error } = await supabase
      .from("jobs")
      .insert({
        title: jobTitle,
        company_id: companyId,
        company_name: companyText,
        location: location ? String(location).trim() : null,
        description: description ? String(description) : null,
        job_url: jobUrl,
        num_openings: num_openings ?? null,
        status: "lead",
      } as any)
      .select("id")
      .single();

    if (error) throw error;

    return res.status(200).json({ ok: true, job_id: job?.id });
  } catch (err: any) {
    console.error("add-job error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to add job" });
  }
}
