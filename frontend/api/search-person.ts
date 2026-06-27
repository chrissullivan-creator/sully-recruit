import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { findPersonMatches, type PersonRole } from "./lib/fuzzy-match-person.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/search-person
 *
 * Finds potential duplicate people across candidates + contacts using a fuzzy
 * matcher: exact email / LinkedIn / phone signals plus Sørensen–Dice
 * similarity over NAME + FIRM (company) + TITLE. Each match carries a
 * `confidence` band and the `matched_on` signals so the inbox Add flow can
 * decide between link-and-update vs create-new.
 *
 * Body: { type: "candidate"|"contact", name, email, phone, linkedin_url,
 *         company?, title? }
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { type, name, email, phone, linkedin_url, company, title } = req.body || {};
  const role: PersonRole = type === "candidate" ? "candidate" : "client";

  const scored = await findPersonMatches(supabase, {
    type: role,
    name,
    email,
    phone,
    linkedin_url,
    company,
    title,
    limit: 5,
  });

  // Shape each match for the wizard: keep the role-specific field names it
  // already reads (current_title/current_company vs title/company_name) AND
  // surface the scoring detail (score/confidence/matched_on) for the new UI.
  const matches = scored.map((m) => ({
    id: m.id,
    type: m.type,
    first_name: m.first_name,
    last_name: m.last_name,
    full_name: m.full_name,
    email: m.email,
    linkedin_url: m.linkedin_url,
    phone: m.phone,
    current_title: m.type === "candidate" ? m.title : undefined,
    current_company: m.type === "candidate" ? m.company : undefined,
    title: m.type === "contact" ? m.title : undefined,
    company_name: m.type === "contact" ? m.company : undefined,
    score: m.score,
    confidence: m.confidence,
    matched_on: m.matched_on,
    name_sim: m.name_sim,
    company_sim: m.company_sim,
    title_sim: m.title_sim,
  }));

  return res.status(200).json({ matches });
}
