import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";
import { hybridSearch } from "../lib/brain-hybrid-search.js";

/**
 * POST /api/brain/search
 *
 * Universal hybrid (FTS + semantic) search over everything indexed in
 * search_documents — people, jobs, companies, messages, calls, send-outs,
 * notes, resumes. Used by the Sully Brain custom GPT as the entry-point
 * tool: "find me anything about X".
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  try {
    const query = String(req.body?.query ?? "").trim();
    if (!query) return res.status(400).json({ error: "query required" });

    const requestedKinds = Array.isArray(req.body?.kinds)
      ? req.body.kinds.filter((k: unknown) => typeof k === "string")
      : null;
    const limit = Math.min(Math.max(Number(req.body?.limit) || 12, 1), 50);

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const hits = await hybridSearch(supabase, query, {
      kinds: requestedKinds ?? undefined,
      limit,
    });

    return res.status(200).json({
      query,
      kinds: requestedKinds,
      count: hits.length,
      results: hits.map((h) => ({
        kind: h.kind,
        id: h.source_id,
        title: h.title,
        subtitle: h.subtitle,
        excerpt: h.body,
        url: h.url,
        matched_via: h.matched_via,
        score: Number(h.score.toFixed(4)),
        metadata: h.metadata,
      })),
    });
  } catch (err: any) {
    console.error("brain/search error:", err?.message);
    return res.status(500).json({ error: err?.message ?? "search_failed" });
  }
}
