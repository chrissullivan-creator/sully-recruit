import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/** Mirror of add-person's consumer-domain check so a bare email lands in the
 *  same typed column the contacts INSTEAD-OF trigger would choose. */
const CONSUMER_EMAIL_DOMAINS =
  /^(gmail|yahoo|hotmail|outlook|icloud|me|mac|aol|msn|live|protonmail|proton|fastmail|comcast|verizon|sbcglobal|att|optonline|ymail|hush|gmx|zoho|tutanota|cox|charter|earthlink|bellsouth|hanmail|naver)\.[a-z.]+$/i;

function isConsumerDomain(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at < 0) return false;
  return CONSUMER_EMAIL_DOMAINS.test(addr.slice(at + 1).toLowerCase());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/update-person
 *
 * Refreshes an EXISTING person with the newest info gathered from a thread /
 * LinkedIn lookup, then links the conversation to them. This is the
 * "found a fuzzy match → Connect & Update" path of the inbox Add flow.
 *
 * Update rule: OVERWRITE WITH NEWEST. Any non-empty field in `data` replaces
 * the stored value (title, company, linkedin, email, phone, location, avatar,
 * headline, name). Empty/missing fields never wipe existing data.
 *
 * Body: { person_id, type: "candidate"|"contact"|"client", data: {...fields},
 *         conversation_id?, provider_id? }
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

  const { person_id, type: rawType, data, conversation_id, provider_id } = req.body || {};
  if (!person_id || !data) {
    return res.status(400).json({ error: "Missing person_id or data" });
  }
  const role: "candidate" | "client" = rawType === "candidate" ? "candidate" : "client";
  const providerId: string | null =
    typeof provider_id === "string" && provider_id.trim() ? provider_id.trim() : null;

  try {
    const { data: existing, error: exErr } = await supabase
      .from("people")
      .select("id, roles, type")
      .eq("id", person_id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: "Person not found" });

    const str = (v: any): string | null => {
      const t = typeof v === "string" ? v.trim() : "";
      return t.length ? t : null;
    };

    // OVERWRITE-with-newest: only set keys whose incoming value is non-empty.
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    const set = (col: string, val: string | null) => {
      if (val !== null) patch[col] = val;
    };

    const firstName = str(data.first_name);
    const lastName = str(data.last_name);
    set("first_name", firstName);
    set("last_name", lastName);
    if (firstName || lastName) {
      // Recompute full_name from the freshest first/last we have.
      const { data: cur } = await supabase
        .from("people")
        .select("first_name, last_name")
        .eq("id", person_id)
        .maybeSingle();
      const fn = firstName || cur?.first_name || "";
      const ln = lastName || cur?.last_name || "";
      const full = `${fn} ${ln}`.trim();
      if (full) patch.full_name = full;
    }

    set("linkedin_url", str(data.linkedin_url));
    set("phone", str(data.phone));
    set("location_text", str(data.location));

    const headline = str(data.headline);
    if (headline) patch.linkedin_headline = headline;

    // Avatar: store in both the raw column and the one the UI renders.
    const photo = str(data.photo) || str(data.avatar_url);
    if (photo) {
      patch.profile_picture_url = photo;
      patch.avatar_url = photo;
    }

    // Email — validate then route into the right typed column.
    const email = str(data.email)?.toLowerCase() ?? null;
    const personalEmail = str(data.personal_email)?.toLowerCase() ?? null;
    const workEmail = str(data.work_email)?.toLowerCase() ?? null;
    for (const [label, addr] of [
      ["email", email],
      ["personal_email", personalEmail],
      ["work_email", workEmail],
    ] as const) {
      if (addr && !EMAIL_RE.test(addr)) {
        return res.status(400).json({ error: `Invalid ${label} format` });
      }
    }
    if (personalEmail) patch.personal_email = personalEmail;
    if (workEmail) patch.work_email = workEmail;
    if (email && !personalEmail && !workEmail) {
      if (isConsumerDomain(email)) patch.personal_email = email;
      else patch.work_email = email;
    }

    // Role-specific title/company columns.
    const title = str(data.title);
    const company = str(data.company);
    if (role === "candidate") {
      set("current_title", title);
      set("current_company", company);
    } else {
      set("title", title);
      set("company_name", company);
      if (str(data.company_id)) patch.company_id = data.company_id;
    }

    // Append the role if this person didn't already hold it (dual-role).
    const currentRoles: string[] = Array.isArray(existing.roles) && existing.roles.length
      ? existing.roles
      : (existing.type ? [existing.type] : []);
    if (!currentRoles.includes(role)) {
      patch.roles = [...currentRoles, role];
    }

    const { error: upErr } = await supabase.from("people").update(patch as any).eq("id", person_id);
    if (upErr) throw upErr;

    // Link the conversation + backfill its messages to this person.
    if (conversation_id) {
      const linkCol = role === "candidate" ? "candidate_id" : "contact_id";
      await supabase.from("conversations").update({ [linkCol]: person_id }).eq("id", conversation_id);
      await supabase
        .from("messages")
        .update({ [linkCol]: person_id })
        .eq("conversation_id", conversation_id)
        .is(linkCol, null);
    }

    // Cache the LinkedIn provider id so future inbound messages hard-match.
    if (providerId) {
      try {
        await supabase.from("candidate_channels").upsert(
          { candidate_id: person_id, channel: "linkedin", provider_id: providerId } as any,
          { onConflict: "candidate_id,channel" },
        );
      } catch (e: any) {
        console.warn("candidate_channels cache failed (non-fatal):", e?.message);
      }
    }

    return res.status(200).json({ id: person_id, updated: true });
  } catch (err: any) {
    console.error("update-person error:", err?.message);
    return res.status(500).json({ error: err?.message || "Update failed" });
  }
}
