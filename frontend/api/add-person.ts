import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/add-person
 *
 * Creates a new contact or candidate record in Supabase.
 * Optionally links a conversation and backfills messages.
 *
 * Body: { type: "candidate"|"contact", data: {...fields}, conversation_id?: string }
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  // Auth
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { type, data, conversation_id } = req.body || {};
  if (!type || !data?.first_name || !data?.last_name) {
    return res.status(400).json({ error: "Missing type, first_name, or last_name" });
  }

  const fullName = `${data.first_name.trim()} ${data.last_name.trim()}`.trim();

  try {
    let inserted: any;

    if (type === "candidate") {
      const payload: Record<string, any> = {
        first_name: data.first_name.trim(),
        last_name: data.last_name.trim(),
        full_name: fullName,
        email: data.email?.trim() || null,
        phone: data.phone?.trim() || null,
        linkedin_url: data.linkedin_url?.trim() || null,
        current_title: data.title?.trim() || null,
        current_company: data.company?.trim() || null,
        location_text: data.location?.trim() || null,
        status: "new",
        owner_id: user.id,
      };
      if (data.current_salary?.trim()) payload.current_base_comp = data.current_salary.trim();
      if (data.desired_salary?.trim()) payload.target_base_comp = data.desired_salary.trim();
      if (data.notes?.trim()) payload.back_of_resume_notes = data.notes.trim();

      const { data: row, error } = await supabase
        .from("candidates")
        .insert(payload)
        .select("id, full_name")
        .single();
      if (error) throw error;
      inserted = row;
    } else {
      const payload: Record<string, any> = {
        first_name: data.first_name.trim(),
        last_name: data.last_name.trim(),
        full_name: fullName,
        email: data.email?.trim() || null,
        phone: data.phone?.trim() || null,
        linkedin_url: data.linkedin_url?.trim() || null,
        title: data.title?.trim() || null,
        company_name: data.company?.trim() || null,
        location: data.location?.trim() || null,
        status: "active",
        owner_id: user.id,
      };
      if (data.company_id) payload.company_id = data.company_id;
      if (data.notes?.trim()) payload.notes = data.notes.trim();

      const { data: row, error } = await supabase
        .from("contacts")
        .insert(payload)
        .select("id, full_name")
        .single();
      if (error) throw error;
      inserted = row;
    }

    // Link conversation if provided
    if (conversation_id && inserted?.id) {
      const linkCol = type === "candidate" ? "candidate_id" : "contact_id";
      await supabase
        .from("conversations")
        .update({ [linkCol]: inserted.id })
        .eq("id", conversation_id);

      // Backfill messages in this conversation
      await supabase
        .from("messages")
        .update({ [linkCol]: inserted.id })
        .eq("conversation_id", conversation_id)
        .is(linkCol, null);
    }

    return res.status(200).json({ id: inserted.id, type });
  } catch (err: any) {
    console.error("Insert failed:", err);
    return res.status(500).json({ error: err.message || "Insert failed" });
  }
}
