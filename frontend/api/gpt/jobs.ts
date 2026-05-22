import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireGptAuth, handleCors } from "../lib/gpt-auth.js";

/**
 * GET /api/gpt/jobs?company=&title=&keyword=
 *
 * Search open/active job records for the "Ask Joe Send Outs Emerald" GPT.
 *
 * Source table: `jobs`. Note: this schema uses `title` (not `job_title`)
 * and `description` (not `job_spec`). Returns up to 10 records with a
 * truncated job-spec preview so the GPT can show options without
 * loading every full description.
 */

// ── Table / column constants (rename if your schema differs) ─────────
const TABLE = "jobs";
const COLS_LIST = [
  "id",
  "company_name",
  "title",
  "location",
  "status",
  "description",
  "compensation",
  "updated_at",
].join(", ");
const JOB_SPEC_PREVIEW_LEN = 400;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireGptAuth(req, res)) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured: Supabase env vars missing" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const company = String(req.query.company || "").trim();
  const title = String(req.query.title || "").trim();
  const keyword = String(req.query.keyword || "").trim();

  if (!company && !title && !keyword) {
    return res.status(400).json({ error: "Provide company, title, or keyword query param" });
  }

  try {
    // Hide soft-deleted rows by default — jobs table has a deleted_at column.
    let q = supabase.from(TABLE).select(COLS_LIST).is("deleted_at", null).limit(10);

    if (company) {
      q = q.ilike("company_name", `%${company}%`);
    }
    if (title) {
      q = q.ilike("title", `%${title}%`);
    }
    if (keyword) {
      q = q.or(
        [
          `company_name.ilike.%${keyword}%`,
          `title.ilike.%${keyword}%`,
          `description.ilike.%${keyword}%`,
        ].join(","),
      );
    }

    q = q.order("updated_at", { ascending: false });

    const { data, error } = await q;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const jobs = (data ?? []).map((j: any) => ({
      id: j.id,
      company_name: j.company_name,
      job_title: j.title,
      location: j.location,
      status: j.status,
      compensation: j.compensation,
      job_spec_preview: j.description
        ? String(j.description).slice(0, JOB_SPEC_PREVIEW_LEN) +
          (j.description.length > JOB_SPEC_PREVIEW_LEN ? "…" : "")
        : null,
      updated_at: j.updated_at,
    }));

    return res.status(200).json({ jobs });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Search failed" });
  }
}
