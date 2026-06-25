import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { resolveV2Ctx, flattenProfile, mapPipelineStage } from "./source-projects.js";

/**
 * POST /api/linkedin-recruiter-search
 *
 * Runs Unipile v2 "Perform Recruiter Search from URL"
 * (POST /v2/{acc_xxx}/linkedin/recruiter/search, body { url }) on behalf of a
 * selected LinkedIn seat, paginates the results, and returns them flattened for
 * the admin import preview. READ-ONLY — performs no DB writes (the import step
 * is a separate /api/add-person call per row the user approves).
 *
 * Body: { account_id, url, limit? }
 *   account_id: integration_accounts Unipile id (v1 short id OR acc_xxx — resolveV2Ctx accepts either)
 *   url:        a LinkedIn Recruiter search / project-pipeline URL
 *   limit:      max people to pull (default 300, hard max 500)
 *
 * Auth: Supabase JWT.
 */
const PAGE_SIZE = 100; // search/applicants channel max per page
const DEFAULT_CAP = 300;
const MAX_CAP = 500;

type PreviewRow = {
  candidate_id: string | null;
  first_name: string;
  last_name: string;
  name: string;
  headline: string | null;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  stage: string;
  has_resume: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { account_id, url, limit } = req.body || {};
  if (!account_id || typeof account_id !== "string") {
    return res.status(400).json({ error: "account_id is required" });
  }
  const searchUrl = typeof url === "string" ? url.trim() : "";
  if (!searchUrl) return res.status(400).json({ error: "url is required" });
  if (!/^https?:\/\/([\w-]+\.)?linkedin\.com\//i.test(searchUrl)) {
    return res.status(400).json({ error: "Enter a LinkedIn Recruiter URL (it must start with https://www.linkedin.com/)" });
  }

  const ctx = await resolveV2Ctx(supabase, account_id);
  if ("error" in ctx) return res.status(ctx.status).json({ error: ctx.error, code: (ctx as any).code });

  const cap = Math.min(Math.max(Number(limit) || DEFAULT_CAP, 1), MAX_CAP);
  const people: PreviewRow[] = [];
  let cursor: string | null = null;
  let totalCount = 0;
  let pages = 0;

  try {
    do {
      const u = new URL(`${ctx.v2Base}/${encodeURIComponent(ctx.accV2)}/linkedin/recruiter/search`);
      u.searchParams.set("limit", String(Math.min(PAGE_SIZE, cap - people.length)));
      if (cursor) u.searchParams.set("cursor", cursor);

      const resp = await fetch(u.toString(), {
        method: "POST",
        headers: { "X-API-KEY": ctx.v2Key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: searchUrl }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        const status = resp.status >= 400 && resp.status < 600 ? resp.status : 502;
        return res.status(status).json({ error: `Unipile ${resp.status}: ${text.slice(0, 300)}` });
      }
      let json: any = {};
      try { json = JSON.parse(text); } catch { json = {}; }
      if (typeof json?.total_count === "number") totalCount = json.total_count;

      const rows = Array.isArray(json?.data) ? json.data : [];
      for (const raw of rows) {
        if (people.length >= cap) break;
        const flat = flattenProfile(raw);
        const name = [flat.first_name, flat.last_name].filter(Boolean).join(" ").trim();
        people.push({
          candidate_id: flat.candidate_id,
          first_name: flat.first_name || "",
          last_name: flat.last_name || "",
          name: name || flat.headline || "",
          headline: flat.headline ?? null,
          current_title: flat.current_title ?? null,
          current_company: flat.current_company ?? null,
          location: flat.location ?? null,
          linkedin_url: flat.linkedin_url ?? null,
          avatar_url: flat.avatar_url ?? null,
          email: flat.email ?? null,
          phone: flat.phone ?? null,
          stage: mapPipelineStage(flat.pipeline_stage),
          has_resume: !!flat.has_resume,
        });
      }
      // Only continue while the provider keeps handing back a cursor AND rows.
      cursor = rows.length > 0 && typeof json?.next_cursor === "string" && json.next_cursor
        ? json.next_cursor
        : null;
      pages++;
    } while (cursor && people.length < cap && pages < 60);

    return res.status(200).json({
      people,
      total_count: totalCount || people.length,
      fetched: people.length,
      truncated: !!cursor && people.length >= cap,
    });
  } catch (err: any) {
    console.error("linkedin-recruiter-search error:", err?.message || err);
    return res.status(502).json({ error: err?.message || "Recruiter search failed" });
  }
}
