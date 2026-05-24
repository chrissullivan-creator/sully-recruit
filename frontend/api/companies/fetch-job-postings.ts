import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { getPdlConfig, pdlSearchJobs, type JobSpecFilters } from "../lib/integrations/pdl.js";

/**
 * POST /api/companies/fetch-job-postings
 *
 * Pull current job postings for one or more companies from PDL and
 * upsert them into company_job_postings. Incremental: each fetch
 * passes `since = last_fetched_at` so we only pull the delta.
 *
 *   Body: {
 *     companyIds: string[]   // up to 50 per call
 *   }
 *
 * Per-company flow:
 *   1. Load career_urls. If none, treat the company's `domain` as a
 *      single implicit career URL (covers the common case where the
 *      operator hasn't added explicit URLs yet).
 *   2. For each URL: PDL job/search with since=last_fetched_at and
 *      either `companyDomain` (preferred) or `companyName`.
 *   3. Insert with ON CONFLICT DO NOTHING on (company_id, external_id).
 *      Dismissed postings stay dismissed — they're already in the table
 *      so the dedup constraint skips them silently.
 *   4. Stamp career_urls.last_fetched_at + last_fetched_status.
 *
 * Returns per-company counts so the caller can show "N new postings
 * across M companies".
 */

interface PerCompanyResult {
  company_id: string;
  ok: boolean;
  error?: string;
  new_postings: number;
  total_active: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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

  const companyIds: string[] = Array.isArray(req.body?.companyIds) ? req.body.companyIds : [];
  if (companyIds.length === 0) return res.status(400).json({ error: "companyIds[] required" });
  if (companyIds.length > 50) return res.status(400).json({ error: "Max 50 per request" });

  const pdlConfig = await getPdlConfig(supabase);
  if (!pdlConfig) {
    return res.status(500).json({ error: "PDL_API_KEY not configured in app_settings" });
  }

  // Load the operator's saved job-spec filters. This is the difference
  // between pulling every JP Morgan job (no filter) and only the
  // ones matching "senior engineering leaders in fintech NYC".
  const { data: specRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "JOB_SPEC_PDL_FILTERS")
    .maybeSingle();
  let specFilters: JobSpecFilters | null = null;
  if (specRow?.value && specRow.value !== "{}") {
    try { specFilters = JSON.parse(specRow.value); } catch { /* malformed → ignore */ }
  }

  const { data: companies, error: cErr } = await supabase
    .from("companies")
    .select("id, name, domain")
    .in("id", companyIds);
  if (cErr) return res.status(500).json({ error: `companies lookup failed: ${cErr.message}` });

  const { data: careerUrls, error: uErr } = await supabase
    .from("company_career_urls")
    .select("id, company_id, url, label, last_fetched_at")
    .in("company_id", companyIds);
  if (uErr) return res.status(500).json({ error: `career_urls lookup failed: ${uErr.message}` });

  const urlsByCompany = new Map<string, any[]>();
  for (const cu of careerUrls ?? []) {
    const list = urlsByCompany.get(cu.company_id) ?? [];
    list.push(cu);
    urlsByCompany.set(cu.company_id, list);
  }

  const results: PerCompanyResult[] = [];
  let pdlCalls = 0;

  for (const company of companies ?? []) {
    let newPostings = 0;
    const urls = urlsByCompany.get(company.id) ?? [];

    // No explicit career URLs → fall back to the company's domain.
    // We synthesize a "virtual" URL entry so the loop below stays uniform.
    const fetchTargets = urls.length > 0
      ? urls
      : (company.domain ? [{ id: null, url: company.domain, last_fetched_at: null }] : []);

    if (fetchTargets.length === 0) {
      results.push({
        company_id: company.id, ok: false,
        error: "no career URLs and no domain",
        new_postings: 0, total_active: 0,
      });
      continue;
    }

    for (const target of fetchTargets) {
      let postings = [];
      try {
        postings = await pdlSearchJobs(pdlConfig, {
          companyDomain: company.domain,
          companyName: !company.domain ? company.name : null,
          since: target.last_fetched_at,
          size: 100,
          filters: specFilters,
        });
        pdlCalls += 1;
      } catch (err: any) {
        if (target.id) {
          await supabase
            .from("company_career_urls")
            .update({
              last_fetched_at: new Date().toISOString(),
              last_fetched_status: "error",
              last_fetched_error: err?.message?.slice(0, 200) ?? "unknown",
            })
            .eq("id", target.id);
        }
        continue;
      }

      if (postings.length > 0) {
        const rows = postings.map((p) => ({
          company_id: company.id,
          career_url_id: target.id,
          external_id: p.external_id,
          title: p.title,
          location: p.location_name,
          employment_type: p.employment_type,
          seniority: p.seniority,
          description: p.description,
          posted_at: p.posted_at,
          source_url: p.source_url,
          raw: p.raw,
        }));

        // ON CONFLICT DO NOTHING via upsert with ignoreDuplicates skips
        // existing rows (including dismissed ones — they keep their state).
        const { error: insErr, count } = await supabase
          .from("company_job_postings")
          .upsert(rows, { onConflict: "company_id,external_id", ignoreDuplicates: true, count: "exact" });
        if (!insErr && typeof count === "number") newPostings += count;
      }

      if (target.id) {
        await supabase
          .from("company_career_urls")
          .update({
            last_fetched_at: new Date().toISOString(),
            last_fetched_status: postings.length > 0 ? "ok" : "no_results",
            last_fetched_error: null,
          })
          .eq("id", target.id);
      }
    }

    const { count: activeCount } = await supabase
      .from("company_job_postings")
      .select("id", { count: "exact", head: true })
      .eq("company_id", company.id)
      .is("dismissed_at", null);

    results.push({
      company_id: company.id, ok: true,
      new_postings: newPostings,
      total_active: activeCount ?? 0,
    });
  }

  return res.status(200).json({
    results,
    credits: { pdl_calls: pdlCalls },
    counts: {
      companies: companyIds.length,
      processed: results.length,
      new_postings: results.reduce((s, r) => s + r.new_postings, 0),
    },
  });
}
