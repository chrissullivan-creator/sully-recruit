import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/person
 *
 * Full profile for one person (candidate or client). Looks up the unified
 * candidates view by id OR by free-text name/email/linkedin handle.
 *
 * Body: { person_id?: string, query?: string }
 *
 * If query is given and matches multiple people, returns the top 5 so
 * the GPT can ask the user to disambiguate.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const personId = typeof req.body?.person_id === "string" ? req.body.person_id.trim() : "";
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";

  if (!personId && !query) {
    return res.status(400).json({ error: "person_id or query required" });
  }

  const select =
    "id, full_name, first_name, last_name, type, roles, status, current_title, current_company, location_text, " +
    "email, work_email, personal_email, secondary_emails, mobile_phone, phone, linkedin_url, " +
    "current_base_comp, current_total_comp, target_base_comp, target_total_comp, comp_notes, " +
    "visa_status, work_authorization, target_locations, target_roles, reason_for_leaving, " +
    "joe_says, candidate_summary, back_of_resume_notes, fun_facts, where_interviewed, where_submitted, " +
    "last_contacted_at, last_responded_at, last_spoken_at, last_comm_channel, last_sequence_sentiment, " +
    "created_at, updated_at, owner_user_id, skills, linkedin_headline";

  if (personId) {
    const { data, error } = await supabase
      .from("candidates")
      .select(select)
      .eq("id", personId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "person not found", person_id: personId });
    return res.status(200).json({ person: clip(data) });
  }

  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 4);
  const orFilter = tokens
    .flatMap((t) => [
      `full_name.ilike.%${t}%`,
      `first_name.ilike.%${t}%`,
      `last_name.ilike.%${t}%`,
      `email.ilike.%${t}%`,
      `current_company.ilike.%${t}%`,
      `linkedin_url.ilike.%${query}%`,
    ])
    .join(",");

  const { data, error } = await supabase
    .from("candidates")
    .select(select)
    .or(orFilter)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    return res.status(404).json({ error: "no people matched query", query });
  }
  if (data.length === 1) return res.status(200).json({ person: clip(data[0]) });
  return res.status(200).json({
    matches: data.map(clip).slice(0, 5),
    note: "multiple matches — pick one and re-call with person_id",
  });
}

function clip(p: any) {
  if (typeof p?.joe_says === "string") p.joe_says = p.joe_says.slice(0, 3000);
  if (typeof p?.candidate_summary === "string") p.candidate_summary = p.candidate_summary.slice(0, 2000);
  if (typeof p?.back_of_resume_notes === "string") p.back_of_resume_notes = p.back_of_resume_notes.slice(0, 2000);
  return p;
}
