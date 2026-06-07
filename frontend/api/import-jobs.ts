import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/import-jobs
 *
 * Bulk-imports rows from a CSV into the `jobs` table as leads. Mirrors the
 * dedupe + company-link behaviour of /api/add-job, processing up to MAX_ROWS
 * rows per request in internal chunks.
 *
 * Per row:
 *   - Skip (count as DUPLICATE) when a non-deleted job already exists with the
 *     same job_url.
 *   - Otherwise insert with status='lead', company_name set from the row, and
 *     a best-effort company_id linked by case-insensitive company name match.
 *
 * Body: { rows: JobRow[] }
 *   JobRow = { title (required), company?, location?, description?, job_url? }
 *
 * Returns: {
 *   created:    string[]          // ids of newly-inserted jobs
 *   duplicates: string[]          // ids of pre-existing jobs matched by job_url
 *   failed:     { index, error }[] // 0-based index into the submitted rows
 * }
 *
 * Auth: Bearer Supabase JWT (logged-in recruiter) or service-role key.
 */

const MAX_ROWS = 1000;
const CHUNK = 25;

type JobRow = {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  job_url?: string;
};

const clean = (v: unknown): string => (v == null ? "" : String(v).trim());

async function processRow(
  supabase: SupabaseClient,
  row: JobRow,
): Promise<{ id: string; duplicate: boolean }> {
  const title = clean(row.title);
  if (!title) throw new Error("title is required");

  const jobUrl = clean(row.job_url) || null;

  // De-dupe on the job URL so re-importing the same export doesn't pile up
  // duplicate leads.
  if (jobUrl) {
    const { data: existing } = await supabase
      .from("jobs")
      .select("id")
      .eq("job_url", jobUrl)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (existing?.id) return { id: existing.id, duplicate: true };
  }

  const companyText = clean(row.company) || null;

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
      title,
      company_id: companyId,
      company_name: companyText,
      location: clean(row.location) || null,
      description: clean(row.description) || null,
      job_url: jobUrl,
      status: "lead",
    } as any)
    .select("id")
    .single();
  if (error) throw error;
  return { id: job.id, duplicate: false };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const rows: JobRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: "rows[] required" });
  if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Max ${MAX_ROWS} rows per request` });

  const supabase = createClient(supabaseUrl, serviceKey);

  const created: string[] = [];
  const duplicates: string[] = [];
  const failed: { index: number; error: string }[] = [];

  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    const results = await Promise.allSettled(slice.map((row) => processRow(supabase, row)));
    results.forEach((r, i) => {
      const index = start + i;
      if (r.status === "fulfilled") {
        if (r.value.duplicate) duplicates.push(r.value.id);
        else created.push(r.value.id);
      } else {
        const reason: any = r.reason;
        failed.push({ index, error: reason?.message || String(reason) || "unknown error" });
      }
    });
  }

  return res.status(200).json({ created, duplicates, failed });
}
