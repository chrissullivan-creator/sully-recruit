import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";
import { inngest } from "../lib/inngest/client.js";

/**
 * POST /api/brain/find-linkedin-urls
 *
 * Kick the LinkedIn URL finder for people without a URL. Fires
 * `people/find-linkedin-url.requested` events; the existing
 * find-linkedin-url-by-name Inngest function tries Apollo first
 * (/people/match) and falls back to Unipile recruiter search.
 *
 * Body: { limit?: number (default 250, max 500) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  try {
    const requested = Number(req.body?.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 500)
      : 250;

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: people, error } = await supabase
      .from("people")
      .select("id, full_name, first_name, last_name, current_company, primary_email, work_email, personal_email")
      .or("linkedin_url.is.null,linkedin_url.eq.")
      .or("linkedin_search_status.is.null,linkedin_search_status.eq.pending")
      .neq("is_stub", true)
      .order("linkedin_search_attempted_at", { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const eligible = (people ?? []).filter((p: any) => {
      const hasName = !!(p.full_name || (p.first_name && p.last_name));
      const hasSignal = !!(p.primary_email || p.work_email || p.personal_email || p.current_company);
      return hasName && hasSignal;
    });

    if (!eligible.length) {
      return res.status(200).json({ dispatched: 0, note: "no eligible people for LinkedIn lookup" });
    }

    const stamp = Math.floor(Date.now() / 60_000);
    const events = eligible.map((p: any) => ({
      id: `find-linkedin-${p.id}-brain-${stamp}`,
      name: "people/find-linkedin-url.requested" as const,
      data: { person_id: p.id },
    }));

    let dispatched = 0;
    const chunkSize = 500;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      await inngest.send(chunk);
      dispatched += chunk.length;
    }

    const { count: stillMissing } = await supabase
      .from("people")
      .select("id", { count: "exact", head: true })
      .or("linkedin_url.is.null,linkedin_url.eq.")
      .neq("is_stub", true);

    return res.status(200).json({
      dispatched,
      backlog_remaining: stillMissing ?? null,
      source: "Apollo /people/match (primary), Unipile recruiter search (fallback)",
    });
  } catch (err: any) {
    console.error("brain/find-linkedin-urls error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
