import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/search-person
 *
 * Searches both candidates and contacts tables for potential duplicate matches.
 * Uses email, LinkedIn URL, phone (last 7 digits), and name for matching.
 *
 * Body: { type: "candidate"|"contact", name, email, phone, linkedin_url }
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { type, name, email, phone, linkedin_url } = req.body || {};
  const primaryTable = type === "candidate" ? "candidates" : "contacts";
  const otherTable = type === "candidate" ? "contacts" : "candidates";
  const primaryType = type === "candidate" ? "candidate" : "contact";
  const otherType = type === "candidate" ? "contact" : "candidate";

  const matches: any[] = [];

  const selectFields = "id, first_name, last_name, full_name, email, work_email, personal_email, secondary_emails, phone, linkedin_url";
  const candidateExtra = ", current_title, current_company";
  const contactExtra = ", title, company_name";

  const getSelect = (table: string) =>
    table === "candidates" ? selectFields + candidateExtra : selectFields + contactExtra;

  // Search a table with all available signals
  const searchTable = async (table: string, assignType: string) => {
    const sel = getSelect(table);

    // Email match (strongest). Check every column we store addresses in:
    // primary_email (alias `email`), work_email, personal_email, and the
    // secondary_emails text[] array. Without this an existing person who
    // only has the typed work/personal column populated would slip past
    // dedup detection.
    if (email) {
      const lc = String(email).toLowerCase();
      const { data } = await supabase
        .from(table)
        .select(sel)
        .or(
          `email.ilike.${lc},work_email.ilike.${lc},personal_email.ilike.${lc},secondary_emails.cs.{${lc}}`,
        )
        .limit(5);
      if (data) matches.push(...data.map((d: any) => ({ ...d, type: assignType })));
    }

    // LinkedIn match
    if (linkedin_url) {
      const normalized = linkedin_url.replace(/\/$/, "").split("?")[0].toLowerCase();
      const slug = normalized.split("/in/")[1];
      if (slug) {
        const { data } = await supabase.from(table).select(sel).ilike("linkedin_url", `%${slug}%`).limit(5);
        if (data) matches.push(...data.map((d: any) => ({ ...d, type: assignType })));
      }
    }

    // Phone match (last 7 digits)
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length >= 7) {
        const { data } = await supabase.from(table).select(sel).ilike("phone", `%${digits.slice(-7)}%`).limit(5);
        if (data) matches.push(...data.map((d: any) => ({ ...d, type: assignType })));
      }
    }

    // Name match (weakest)
    if (name && name.trim().length > 2) {
      const parts = name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(" ");
      if (lastName) {
        const { data } = await supabase
          .from(table)
          .select(sel)
          .ilike("first_name", `%${firstName}%`)
          .ilike("last_name", `%${lastName}%`)
          .limit(5);
        if (data) matches.push(...data.map((d: any) => ({ ...d, type: assignType })));
      }
    }
  };

  await Promise.all([
    searchTable(primaryTable, primaryType),
    searchTable(otherTable, otherType),
  ]);

  // Dedupe by id+type
  const seen = new Set<string>();
  const deduped = matches.filter((m) => {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return res.status(200).json({ matches: deduped });
}
