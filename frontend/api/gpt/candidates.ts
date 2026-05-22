import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireGptAuth, handleCors } from "../lib/gpt-auth.js";

/**
 * GET /api/gpt/candidates?name=&keyword=
 *
 * Search candidates for the "Ask Joe Send Outs Emerald" GPT.
 *
 * Source table: `candidates` (this is a VIEW over `people` filtered to
 * type='candidate'; see CLAUDE.md). Resume text lives in the separate
 * `resumes.raw_text` column — for keyword search we use the merged
 * `ai_search_text` column on the view, which already includes resume
 * content + LinkedIn + back-of-resume notes.
 *
 * Returns up to 10 compact records — no sensitive fields like comp
 * numbers or full resume text in the list response. Full context is
 * fetched via /api/gpt/submission-context once the GPT picks one.
 */

// ── Table / column constants (rename if your schema differs) ─────────
const TABLE = "candidates";
const COLS_LIST = [
  "id",
  "full_name",
  "current_title",
  "current_company",
  "candidate_summary",
  "location_text",
  "status",
  "updated_at",
].join(", ");

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

  const name = String(req.query.name || "").trim();
  const keyword = String(req.query.keyword || "").trim();

  if (!name && !keyword) {
    return res.status(400).json({ error: "Provide name or keyword query param" });
  }

  try {
    let q = supabase.from(TABLE).select(COLS_LIST).limit(10);

    if (name) {
      // Match either the full string or any token: helps when the user
      // types "Pururav" against a row stored as "Pururav Devarasetty".
      const tokens = name.split(/\s+/).filter(Boolean);
      const parts = [
        `full_name.ilike.%${name}%`,
        ...tokens.map((t) => `full_name.ilike.%${t}%`),
      ];
      q = q.or(parts.join(","));
    } else if (keyword) {
      // ai_search_text on the candidates view merges resume + LinkedIn +
      // notes + summary, so one ilike covers the common "find anyone who
      // mentions macro quant" case. We also search the strongly-typed
      // columns so partial matches on title/company still rank.
      q = q.or(
        [
          `full_name.ilike.%${keyword}%`,
          `current_title.ilike.%${keyword}%`,
          `current_company.ilike.%${keyword}%`,
          `candidate_summary.ilike.%${keyword}%`,
          `ai_search_text.ilike.%${keyword}%`,
        ].join(","),
      );
    }

    q = q.order("updated_at", { ascending: false });

    const { data, error } = await q;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Re-shape to match the OpenAPI contract (location, not location_text).
    const candidates = (data ?? []).map((c: any) => ({
      id: c.id,
      full_name: c.full_name,
      current_title: c.current_title,
      current_company: c.current_company,
      summary: c.candidate_summary,
      location: c.location_text,
      status: c.status,
      updated_at: c.updated_at,
    }));

    return res.status(200).json({ candidates });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Search failed" });
  }
}
