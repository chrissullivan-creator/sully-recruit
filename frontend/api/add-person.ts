import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "./lib/inngest/client.js";
import { resolvePerson } from "./lib/identity-resolver.js";

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

  const { type: rawType, data, conversation_id, provider_id } = req.body || {};
  const providerId: string | null = typeof provider_id === "string" && provider_id.trim()
    ? provider_id.trim()
    : null;
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
    // ── Dedup / dual-role merge: do we already know this person? ──
    // Match on email, phone, LinkedIn URL, OR (for inbox adds) the
    // sender's LinkedIn provider id — via the SAME identity resolver the
    // inbound-message pipeline uses. This is what stops "add from inbox"
    // from spawning a duplicate the messages themselves would have matched:
    // previously we only checked email, so adding someone off a LinkedIn
    // thread (which carries no email) always inserted a new row even when
    // their linkedin_url already existed on a record.
    let existing:
      | { id: string; roles: string[] | null; linkedin_url: string | null; phone: string | null }
      | null = null;

    const resolved = await resolvePerson(supabase, "linkedin", {
      providerId,
      linkedinUrl: data.linkedin_url?.trim() || null,
      email: email || personalEmail || workEmail || null,
      phone: data.phone?.trim() || null,
    });
    if (resolved?.personId) {
      const { data: row } = await supabase
        .from("people")
        .select("id, roles, linkedin_url, phone")
        .eq("id", resolved.personId)
        .maybeSingle();
      if (row) existing = row as any;
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

      // Backfill identifiers we matched on but the survivor was missing,
      // so the next inbound message hard-matches without another lookup.
      // Conservative: only fills blanks, never overwrites.
      const patch: Record<string, any> = {
        roles: mergedRoles,
        updated_at: new Date().toISOString(),
      };
      const formLinkedin = data.linkedin_url?.trim();
      const formPhone = data.phone?.trim();
      if (formLinkedin && !existing.linkedin_url) patch.linkedin_url = formLinkedin;
      if (formPhone && !existing.phone) patch.phone = formPhone;

      const { error: upErr } = await supabase
        .from("people")
        .update(patch as any)
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

      // Person-level LinkedIn enrichment from the Add-Person lookup (applies
      // to candidates and clients alike). Photo lands in both
      // profile_picture_url (raw store) and avatar_url (what the People /
      // Candidates / Contacts list + detail UIs actually render). The
      // background Unipile resolver refreshes these later.
      const headline = data.headline?.trim() || null;
      const photo = data.photo?.trim() || null;
      if (headline) payload.linkedin_headline = headline;
      if (photo) {
        payload.profile_picture_url = photo;
        payload.avatar_url = photo;
      }

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
        payload.location_text = data.location?.trim() || null;
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

    // Cache the LinkedIn provider id so future inbound messages from this
    // sender hard-match — resolvePerson reads candidate_channels first.
    // candidate_channels.candidate_id holds the person id regardless of type.
    // Best-effort: a unique-constraint race must not fail the add.
    if (providerId && personId) {
      try {
        await supabase
          .from("candidate_channels")
          .upsert(
            { candidate_id: personId, channel: "linkedin", provider_id: providerId } as any,
            { onConflict: "candidate_id,channel" },
          );
      } catch (e: any) {
        console.warn("candidate_channels cache failed (non-fatal):", e?.message);
      }
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

      // Re-run sentiment/intel now that the (previously unlinked) inbound
      // messages have a person — closes the new-sender sentiment gap.
      // Fire-and-forget; a failure here must not fail the add.
      try {
        await inngest.send({
          name: "comms/conversation.linked",
          data: {
            conversationId: conversation_id,
            entityId: personId,
            entityType: role === "candidate" ? "candidate" : "contact",
            entityColumn: linkCol,
          },
        });
      } catch (e: any) {
        console.warn("conversation.linked event failed (non-fatal):", e?.message);
      }
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
