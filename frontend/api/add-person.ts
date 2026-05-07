import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/** Mirror of the Postgres is_consumer_email_domain() helper so the
 *  client-side resolver matches what the contacts INSTEAD-OF trigger
 *  would do server-side. Add new providers here AND in the SQL fn. */
const CONSUMER_EMAIL_DOMAINS = /^(gmail|yahoo|hotmail|outlook|icloud|me|mac|aol|msn|live|protonmail|proton|fastmail|comcast|verizon|sbcglobal|att|optonline|ymail|hush|gmx|zoho|tutanota|cox|charter|earthlink|bellsouth|hanmail|naver)\.[a-z.]+$/i;

function isConsumerDomain(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at < 0) return false;
  return CONSUMER_EMAIL_DOMAINS.test(addr.slice(at + 1).toLowerCase());
}

/**
 * POST /api/add-person
 *
 * Creates (or extends) a person in the unified `people` table.
 *
 * Dual-role behaviour:
 *   - If an existing person matches by ANY stored email
 *     (email / personal_email / work_email), we DON'T create a
 *     duplicate. We append the new role to their `roles` array, so
 *     the same person can be both candidate AND client.
 *   - Otherwise, insert a fresh row stamped with the chosen role.
 *
 * Body: { type: "candidate"|"contact"|"client", data: {...fields},
 *         conversation_id?: string }
 *   ("contact" is accepted for backwards-compat with the old wizard
 *    label; it's mapped to 'client' when stamping the role.)
 *
 * Auth: Supabase JWT
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

  const { type: rawType, data, conversation_id } = req.body || {};
  if (!rawType || !data?.first_name || !data?.last_name) {
    return res.status(400).json({ error: "Missing type, first_name, or last_name" });
  }

  // Normalize the role. "contact" is the legacy UI term for a client.
  const role: "candidate" | "client" =
    rawType === "candidate" ? "candidate" : "client";

  const fullName = `${data.first_name.trim()} ${data.last_name.trim()}`.trim();
  const email = data.email?.trim().toLowerCase() || null;
  const personalEmail = data.personal_email?.trim().toLowerCase() || null;
  const workEmail = data.work_email?.trim().toLowerCase() || null;

  // Reject malformed emails before they hit Postgres — the table has no
  // CHECK constraint, so junk like "not an email" would otherwise persist
  // and contaminate match keys / dedup scans.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const [label, addr] of [
    ["email", email],
    ["personal_email", personalEmail],
    ["work_email", workEmail],
  ] as const) {
    if (addr && !EMAIL_RE.test(addr)) {
      return res.status(400).json({ error: `Invalid ${label} format` });
    }
  }

  try {
    // ── Dual-role merge: do we already know this person? ────────
    // Check primary_email (the renamed legacy column) plus the typed
    // personal_email / work_email columns. Older rows still carry an
    // address in primary_email; new rows go through classifyEmail and
    // land directly in personal_email or work_email.
    let existing: { id: string; roles: string[] | null } | null = null;
    const candidates = [email, personalEmail, workEmail].filter(Boolean) as string[];
    for (const e of candidates) {
      const { data: rows } = await supabase
        .from("people")
        .select("id, roles")
        .or(`primary_email.ilike.${e},personal_email.ilike.${e},work_email.ilike.${e}`)
        .limit(1);
      if (rows?.[0]) { existing = rows[0]; break; }
    }

    let personId: string;
    let mergedRoles: string[];

    if (existing) {
      // Append the new role if not already present.
      const currentRoles: string[] = Array.isArray(existing.roles) && existing.roles.length
        ? existing.roles
        : [role];
      mergedRoles = currentRoles.includes(role) ? currentRoles : [...currentRoles, role];
      personId = existing.id;

      const { error: upErr } = await supabase
        .from("people")
        .update({ roles: mergedRoles, updated_at: new Date().toISOString() } as any)
        .eq("id", existing.id);
      if (upErr) throw upErr;
    } else {
      // Plain `email` is gone — figure out which typed column the
      // submitted address belongs in if the caller didn't already
      // pass personal/work directly. Consumer-domain → personal,
      // anything else → work.
      let resolvedPersonal = personalEmail;
      let resolvedWork = workEmail;
      if (email && !resolvedPersonal && !resolvedWork) {
        if (isConsumerDomain(email)) resolvedPersonal = email;
        else resolvedWork = email;
      }

      const linkedinUrl = data.linkedin_url?.trim() || null;
      const payload: Record<string, any> = {
        first_name: data.first_name.trim(),
        last_name: data.last_name.trim(),
        full_name: fullName,
        personal_email: resolvedPersonal,
        work_email: resolvedWork,
        phone: data.phone?.trim() || null,
        linkedin_url: linkedinUrl,
        roles: [role],
        // Sync trigger keeps the singular `type` aligned with `roles`.
        status: "new",
        owner_user_id: user.id,
        created_by_user_id: user.id,
        // Queue Unipile v2 resolve via the cron task whenever a LinkedIn
        // URL is provided.
        unipile_resolve_status: linkedinUrl ? "pending" : null,
      };
      if (role === "candidate") {
        payload.current_title = data.title?.trim() || null;
        payload.current_company = data.company?.trim() || null;
        payload.location_text = data.location?.trim() || null;
        if (data.current_salary?.trim()) payload.current_base_comp = data.current_salary.trim();
        if (data.desired_salary?.trim()) payload.target_base_comp = data.desired_salary.trim();
        if (data.notes?.trim()) payload.back_of_resume_notes = data.notes.trim();
      } else {
        payload.title = data.title?.trim() || null;
        payload.company_name = data.company?.trim() || null;
        payload.location = data.location?.trim() || null;
        if (data.company_id) payload.company_id = data.company_id;
        if (data.notes?.trim()) payload.notes = data.notes.trim();
      }

      const { data: row, error } = await supabase
        .from("people")
        .insert(payload)
        .select("id, roles")
        .single();
      if (error) throw error;
      personId = row.id;
      mergedRoles = (row.roles as string[]) ?? [role];
    }

    // Link conversation if provided. The conversation's foreign key
    // depends on the role we just associated with this person:
    //   candidate role  → candidate_id
    //   client role     → contact_id (legacy column name)
    if (conversation_id && personId) {
      const linkCol = role === "candidate" ? "candidate_id" : "contact_id";
      await supabase
        .from("conversations")
        .update({ [linkCol]: personId })
        .eq("id", conversation_id);

      await supabase
        .from("messages")
        .update({ [linkCol]: personId })
        .eq("conversation_id", conversation_id)
        .is(linkCol, null);
    }

    return res.status(200).json({
      id: personId,
      type: role,
      roles: mergedRoles,
      merged: !!existing,
    });
  } catch (err: any) {
    console.error("Insert failed:", err);
    return res.status(500).json({ error: err.message || "Insert failed" });
  }
}
