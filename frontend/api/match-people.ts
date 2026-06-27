import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { findPersonMatches, type MatchQuery, type ScoredMatch } from "./lib/fuzzy-match-person.js";

/**
 * POST /api/match-people
 *
 * Batch fuzzy-match a list of incoming people (e.g. a LinkedIn Recruiter import
 * preview) against the existing `people` table, so the UI can surface likely
 * duplicates for review BEFORE inserting — preventing the "same person twice"
 * problem that exact-only dedup misses ("Greg" vs "Gregory", middle names,
 * company-name variants, missing email).
 *
 * Reuses the shared `findPersonMatches` fuzzy matcher (the same one the inbox
 * "Add" flow uses) so scoring/confidence stay consistent across the app.
 *
 * Body: { people: [{ key, name?, first_name?, last_name?, email?, phone?,
 *                     linkedin_url?, company?, title?, type? }] }
 *   - `key` is an opaque caller id echoed back so results can be re-joined to
 *     the source rows (order-independent).
 *   - `type` is 'candidate' | 'client' | 'contact' (contact ≡ client).
 *
 * Returns: { matches: { [key]: ScoredMatch[] } } — up to 3 ranked matches per
 *   input, empty array when nothing plausible was found.
 *
 * Auth: Supabase JWT.
 */
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

  const people = Array.isArray(req.body?.people) ? req.body.people : null;
  if (!people) return res.status(400).json({ error: "Missing people array" });
  // Guard against unbounded fan-out; the import UI caps results at ~500.
  if (people.length > 500) return res.status(400).json({ error: "Too many people (max 500)" });

  const buildQuery = (p: any): MatchQuery => {
    const name =
      (p.name && String(p.name).trim()) ||
      [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
      "";
    const type: "candidate" | "client" = p.type === "candidate" ? "candidate" : "client";
    return {
      type,
      name: name || null,
      email: p.email || null,
      phone: p.phone || null,
      linkedin_url: p.linkedin_url || null,
      company: p.company || null,
      title: p.title || null,
      limit: 3,
    };
  };

  try {
    const matches: Record<string, ScoredMatch[]> = {};

    // Bounded concurrency — findPersonMatches issues several queries each, so a
    // big batch run all at once would exhaust the connection pool.
    const POOL = 6;
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(POOL, people.length) }, async () => {
        while (idx < people.length) {
          const cur = people[idx++];
          const key = String(cur?.key ?? idx);
          try {
            matches[key] = await findPersonMatches(supabase, buildQuery(cur));
          } catch {
            // A single bad row must not fail the whole batch; treat as no match.
            matches[key] = [];
          }
        }
      }),
    );

    return res.status(200).json({ matches });
  } catch (err: any) {
    console.error("match-people failed:", err);
    return res.status(500).json({ error: err.message || "Match failed" });
  }
}
