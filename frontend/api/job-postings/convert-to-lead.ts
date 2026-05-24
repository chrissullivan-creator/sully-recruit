import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/job-postings/convert-to-lead
 *
 * Convert one or more company_job_postings into recruiting leads —
 * each creates a `jobs` row that the firm can work. Link is two-way:
 * job_postings.lead_id → jobs.id, and we also stamp converted_to_lead_at
 * / converted_by_user_id on the posting.
 *
 *   Body: { postingIds: string[] }   // up to 100
 *
 * Per-posting result:
 *   { posting_id, ok, job_id?, error? }
 *
 * Skips postings that already have a lead_id — re-conversion would
 * produce a duplicate jobs row.
 */

interface ConversionResult {
  posting_id: string;
  ok: boolean;
  job_id?: string;
  error?: string;
  skipped_already_converted?: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  let userId: string | null = null;
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
    userId = user.id;
  }

  const postingIds: string[] = Array.isArray(req.body?.postingIds) ? req.body.postingIds : [];
  if (postingIds.length === 0) return res.status(400).json({ error: "postingIds[] required" });
  if (postingIds.length > 100) return res.status(400).json({ error: "Max 100 per request" });

  const { data: postings, error: pErr } = await supabase
    .from("company_job_postings")
    .select("id, company_id, title, description, location, source_url, lead_id")
    .in("id", postingIds);
  if (pErr) return res.status(500).json({ error: `postings lookup failed: ${pErr.message}` });

  const companyIds = [...new Set((postings ?? []).map((p) => p.company_id))];
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .in("id", companyIds);
  const companyNames = new Map<string, string>((companies ?? []).map((c) => [c.id, c.name]));

  const results: ConversionResult[] = [];

  for (const posting of postings ?? []) {
    if (posting.lead_id) {
      results.push({
        posting_id: posting.id, ok: true,
        job_id: posting.lead_id,
        skipped_already_converted: true,
      });
      continue;
    }

    const { data: created, error: insErr } = await supabase
      .from("jobs")
      .insert({
        company_id: posting.company_id,
        company_name: companyNames.get(posting.company_id) ?? null,
        title: posting.title || "Untitled posting",
        description: posting.description,
        location: posting.location,
        job_url: posting.source_url,
        status: "open",
        num_openings: 1,
      })
      .select("id")
      .single();
    if (insErr || !created) {
      results.push({
        posting_id: posting.id, ok: false,
        error: `jobs insert failed: ${insErr?.message ?? "unknown"}`,
      });
      continue;
    }

    const { error: linkErr } = await supabase
      .from("company_job_postings")
      .update({
        lead_id: created.id,
        converted_to_lead_at: new Date().toISOString(),
        converted_by_user_id: userId,
      })
      .eq("id", posting.id);
    if (linkErr) {
      // The jobs row was created, but we couldn't link back. Surface
      // the error so the operator notices; the manual fix is to set
      // lead_id directly. Don't roll back the jobs insert — the user
      // already sees the new lead in their list.
      results.push({
        posting_id: posting.id, ok: false,
        job_id: created.id,
        error: `link failed: ${linkErr.message}`,
      });
      continue;
    }

    results.push({ posting_id: posting.id, ok: true, job_id: created.id });
  }

  return res.status(200).json({
    results,
    counts: {
      requested: postingIds.length,
      created: results.filter((r) => r.ok && !r.skipped_already_converted).length,
      already_converted: results.filter((r) => r.skipped_already_converted).length,
      failed: results.filter((r) => !r.ok).length,
    },
  });
}
