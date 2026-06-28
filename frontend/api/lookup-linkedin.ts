import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/lookup-linkedin
 *
 * Fetches a LinkedIn profile and normalizes it to form-compatible fields for
 * the Add Person wizard. **Everything runs on Unipile v2** — addressed on the
 * v2 host by `acc_xxx` id with UNIPILE_API_KEY_V2.
 *
 * Resolution order (first useful hit wins):
 *   1. unipile_id / linkedin_url → direct profile read
 *      (GET {v2Base}/{acc_xxx}/users/{provider_id-or-slug})
 *   2. chat_id → recover from the thread's chat. Backfilled LinkedIn threads
 *      frequently store only a chat_id (no URL / resolvable provider id). v2 has
 *      no chat-attendees route, but every chat message carries the full `sender`
 *      User object — so we read the chat's messages
 *      (GET {v2Base}/{acc_xxx}/chats/{chat_id}/messages), take an inbound
 *      message's sender, and (when it exposes a public identifier) enrich it via
 *      the direct profile read. The sender object alone is enough to prefill.
 *
 * This endpoint stays self-contained (inlined calls, no shared import) so the
 * Vercel bundler can't drop the dependency.
 *
 * Body: { linkedin_url?, unipile_id?, chat_id?, integration_account_id?, account_id? }
 * Auth: Supabase JWT
 */

/** Loosely-typed Unipile v2 User / profile blob — every field optional. */
interface UnipileProfile {
  first_name?: string;
  last_name?: string;
  display_name?: string;
  name?: string;
  description?: string;
  headline?: string;
  title?: string;
  occupation?: string;
  phone?: string;
  phone_number?: string;
  phone_numbers?: string[];
  public_picture_url?: string;
  public_picture_url_large?: string;
  profile_picture_url?: string;
  picture_url?: string;
  location?: string | { name?: string } | null;
  location_name?: string;
  profile_url?: string;
  public_profile_url?: string;
  url?: string;
  public_identifier?: string;
  email?: string;
  emails?: string[];
  provider_id?: string;
  id?: string;
  // v2 nests location, the SELF marker, AND the structured work history under
  // `specifics`. experience[0] is the current/most-recent role — the reliable
  // source of title + company (vs parsing the free-text headline).
  specifics?: {
    location?: string;
    network_distance?: string;
    experience?: Array<{
      job_title?: string;
      company?: { name?: string } | null;
      started_on?: string;
      ended_on?: string;
    }>;
  } | null;
}

/** A v2 chat message — we only read whether we sent it and its sender. */
interface UnipileMessage {
  is_sender?: boolean;
  sender?: UnipileProfile;
}

/** Just the columns we read off an integration_accounts row. */
interface AccountRow {
  unipile_account_id_v2?: string | null;
  metadata?: unknown;
}

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

  const { linkedin_url, unipile_id, chat_id, integration_account_id, account_id, name } = req.body || {};
  // `name` enables the People-Search fallback for InMail/unknown senders whose
  // provider URN + chat won't resolve — so we still need at least one of these.
  if (!linkedin_url && !unipile_id && !chat_id && !name) return res.status(200).json({});

  try {
    const [{ data: baseRow }, { data: keyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    ]);
    const v2Base = (baseRow?.value || "").replace(/\/+$/, "") || "https://api.unipile.com/v2";
    const apiKeyV2 = keyRow?.value;
    if (!apiKeyV2) {
      console.error("lookup-linkedin: UNIPILE_API_KEY_V2 not set in app_settings");
      return res.status(200).json({});
    }

    // ── Ordered, de-duplicated list of acc_xxx ids to try ──────────────
    // Thread's own account first, then every other connected LinkedIn seat.
    const acctIds: string[] = [];
    const pushAcc = (id?: string | null) => {
      const v = (id || "").trim();
      if (v.startsWith("acc_") && !acctIds.includes(v)) acctIds.push(v);
    };

    if (account_id) pushAcc(account_id);
    if (integration_account_id) {
      const { data } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id_v2, metadata")
        .eq("id", integration_account_id)
        .maybeSingle();
      pushAcc(accV2FromRow(data));
    }
    const { data: allAccts } = await supabase
      .from("integration_accounts")
      .select("unipile_account_id_v2, metadata")
      .eq("provider", "linkedin")
      .eq("is_active", true);
    for (const row of allAccts ?? []) pushAcc(accV2FromRow(row));

    // Every v2 path needs at least one acc_xxx seat — without one we can resolve
    // neither a direct profile nor a chat's messages.
    if (acctIds.length === 0) {
      console.warn("lookup-linkedin: no connected v2 LinkedIn accounts to resolve with");
      return res.status(200).json({});
    }

    // ── Identifiers to resolve (provider id like ACoAA…/AEM…, or vanity slug) ──
    const ids: string[] = [];
    const pushId = (raw?: string | null) => {
      if (!raw) return;
      const m = String(raw).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
      const v = (m ? m[1] : String(raw)).trim();
      if (v && !ids.includes(v)) ids.push(v);
    };
    pushId(unipile_id);
    pushId(linkedin_url);
    if (ids.length === 0 && !chat_id && !name) return res.status(200).json({});

    // ── Try each identifier against each account until one resolves usefully ──
    let profile: UnipileProfile | null = null;
    outer: for (const id of ids) {
      for (const acc of acctIds) {
        const p = await v2GetUser(v2Base, apiKeyV2, acc, id);
        if (hasUsefulProfile(p)) {
          profile = p;
          break outer;
        }
      }
    }

    // ── Recruiter-variant pass ──
    // LinkedIn Recruiter (InMail) senders arrive as an AEM… provider URN that
    // the classic profile read can't resolve. Retry every id/account under the
    // recruiter variant before falling back to the chat — this is what fills
    // title/company/photo for InMail adds.
    if (!profile) {
      outer2: for (const id of ids) {
        for (const acc of acctIds) {
          const p = await v2GetUser(v2Base, apiKeyV2, acc, id, { variant: "linkedin_recruiter" });
          if (hasUsefulProfile(p)) {
            profile = p;
            break outer2;
          }
        }
      }
    }

    // ── Chat fallback (v2) ──
    // When the identifier-based lookup turns up nothing (or there were no
    // identifiers at all), recover a profile from the chat's messages.
    if (!profile && chat_id) {
      profile = await resolveFromChat(v2Base, apiKeyV2, acctIds, String(chat_id));
    }

    // ── Name-search fallback (v2 People Search) ──
    // Last resort for InMail / unknown senders whose provider URN + chat won't
    // resolve (common for Recruiter InMail): search LinkedIn by the sender's
    // name and take the top hit. Gives us a real public profile — URL, provider
    // id, headline/photo/location — to prefill AND a canonical provider id to
    // cache so future inbound messages auto-match. The user reviews the result
    // before saving, so an imperfect top hit is editable, not silently wrong.
    // Requires a full name (≥2 tokens) to keep the search from being noise.
    if (!profile && typeof name === "string" && name.trim().split(/\s+/).length >= 2) {
      profile = await resolveByNameSearch(v2Base, apiKeyV2, acctIds, name.trim());
    }

    if (!profile) return res.status(200).json({});

    // ── Normalize the profile → the wizard's form fields ──
    // Don't gate on having a name; emit whatever fields are present.
    const display = pickString(profile.display_name, profile.name);
    const first = pickString(profile.first_name) || display.split(/\s+/)[0] || "";
    const last = pickString(profile.last_name) || display.split(/\s+/).slice(1).join(" ");

    // Title + company: prefer the STRUCTURED current experience (v2
    // `specifics.experience[0]` = present/most-recent role) — it's the company
    // that drives the people↔companies auto-link. Pick the first entry with no
    // end date (current) else the first listed. Fall back to parsing the
    // free-text headline ("Title at Company") only when no structured data.
    let title = "";
    let company = "";
    const experiences = Array.isArray(profile.specifics?.experience)
      ? profile.specifics!.experience!
      : [];
    const currentExp =
      experiences.find((e) => e && (e.job_title || e.company?.name) && !e.ended_on) ||
      experiences.find((e) => e && (e.job_title || e.company?.name));
    if (currentExp) {
      title = pickString(currentExp.job_title);
      company = pickString(currentExp.company?.name);
    }
    if (!title && !company) {
      const description = pickString(profile.description, profile.headline, profile.title, profile.occupation);
      const split = description.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (split) {
        title = split[1].trim();
        company = split[2].trim();
      } else if (description) {
        title = description;
      }
    }

    const phone = Array.isArray(profile.phone_numbers)
      ? pickString(...profile.phone_numbers)
      : pickString(profile.phone, profile.phone_number);
    const photo = pickString(
      profile.public_picture_url_large,
      profile.public_picture_url,
      profile.profile_picture_url,
      profile.picture_url,
    );
    const locObj = profile.location && typeof profile.location === "object" ? profile.location : null;
    const location = pickString(
      typeof profile.location === "string" ? profile.location : null,
      locObj?.name,
      profile.location_name,
      profile.specifics?.location,
    );
    const resolvedUrl =
      pickString(profile.profile_url, profile.public_profile_url, profile.url) ||
      (profile.public_identifier ? `https://www.linkedin.com/in/${profile.public_identifier}` : "") ||
      (typeof linkedin_url === "string" ? linkedin_url : "");

    const result: Record<string, string> = {};
    if (first) result.first_name = first;
    if (last) result.last_name = last;
    const email = Array.isArray(profile.emails)
      ? pickString(profile.email, ...profile.emails)
      : pickString(profile.email);
    if (email) result.email = email;
    if (phone) result.phone = phone;
    if (title) result.title = title;
    if (company) result.company_name = company;
    if (location) result.location = location;
    if (photo) result.photo = photo;
    if (resolvedUrl) result.linkedin_url = resolvedUrl;
    // Surface the canonical LinkedIn provider id + slug so the caller can cache
    // them on the person — this is how People-Search-resolved InMail senders get
    // a "unipile id" backfilled (the original AEM… recruiter URN doesn't match
    // future classic inbound).
    const resolvedProviderId = pickString(profile.provider_id, profile.id);
    if (resolvedProviderId) result.provider_id = resolvedProviderId;
    if (profile.public_identifier) result.public_identifier = profile.public_identifier;

    return res.status(200).json(result);
  } catch (err) {
    console.error("LinkedIn lookup failed:", err);
    return res.status(200).json({});
  }
}

/** Resolve the canonical acc_xxx from an integration_accounts row, coalescing
 *  the top-level column with the metadata copy (some rows only have one). */
function accV2FromRow(row: AccountRow | null): string | null {
  const direct = row?.unipile_account_id_v2;
  if (typeof direct === "string" && direct.trim()) return direct;
  const meta = row?.metadata;
  if (meta && typeof meta === "object") {
    const v = (meta as Record<string, unknown>).unipile_account_id_v2;
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** True when a fetched profile carries at least one field worth prefilling —
 *  name, role, location, photo, identifier/URL, or contact. Lets sparse
 *  responses through instead of requiring a name (acts as a type guard). */
function hasUsefulProfile(p: UnipileProfile | null): p is UnipileProfile {
  if (!p || typeof p !== "object") return false;
  const locName = typeof p.location === "string" ? p.location : p.location?.name;
  return Boolean(
    p.first_name || p.last_name || p.display_name || p.name ||
    p.description || p.headline || p.title || p.occupation ||
    p.public_identifier || p.profile_url || p.public_profile_url || p.url ||
    p.public_picture_url || p.public_picture_url_large || p.profile_picture_url || p.picture_url ||
    locName || p.location_name || p.specifics?.location ||
    p.email || p.phone || p.phone_number ||
    (Array.isArray(p.phone_numbers) && p.phone_numbers.length > 0),
  );
}

/** GET a Unipile v2 user profile, failing fast (null) on any error/timeout so
 *  resolution falls through to the next id/account instead of hanging the
 *  Add Person wizard. */
async function v2GetUser(
  base: string,
  apiKey: string,
  acc: string,
  id: string,
  opts: { variant?: string } = {},
): Promise<UnipileProfile | null> {
  try {
    const qs = new URLSearchParams();
    // Pull the structured Experience section so we get the current title +
    // company (drives the people↔companies auto-link). Without with_sections
    // the profile comes back with no experience and title/company stay blank.
    qs.set("with_sections", "linkedin_experience");
    // Recruiter InMail senders only resolve under the recruiter variant.
    if (opts.variant) qs.set("variant", opts.variant);
    const r = await fetch(
      `${base}/${encodeURIComponent(acc)}/users/${encodeURIComponent(id)}?${qs.toString()}`,
      { headers: { "X-API-KEY": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(9000) },
    );
    if (!r.ok) return null;
    return (await r.json()) as UnipileProfile;
  } catch {
    return null;
  }
}

/** A single LinkedIn People-Search result (v2). We only read the identity bits
 *  we can prefill from. `id` is the messaging-capable provider id. */
interface PeopleSearchHit {
  id?: string;
  member_id?: string;
  display_name?: string;
  public_identifier?: string;
  profile_url?: string;
  public_picture_url?: string;
  public_picture_url_large?: string;
  headline?: string;
  location?: string;
  industry?: string;
  network_distance?: string;
}

/** Resolve a profile by NAME via the v2 People Search endpoint
 *  (POST /v2/{acc}/linkedin/search/people). Returns the top hit, enriched via a
 *  direct profile read when it exposes a public identifier (so title/company
 *  land too). Used as the final InMail/unknown-sender fallback. */
async function resolveByNameSearch(
  base: string,
  apiKey: string,
  acctIds: string[],
  name: string,
): Promise<UnipileProfile | null> {
  const parts = name.split(/\s+/);
  const first = parts[0] || "";
  const last = parts.slice(1).join(" ") || "";
  for (const acc of acctIds) {
    try {
      const r = await fetch(
        `${base}/${encodeURIComponent(acc)}/linkedin/search/people?limit=5`,
        {
          method: "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            keywords: name,
            advanced_keywords: { first_name: first, last_name: last },
          }),
          signal: AbortSignal.timeout(9000),
        },
      );
      if (!r.ok) continue;
      const j = (await r.json().catch(() => null)) as { data?: PeopleSearchHit[] } | null;
      const results = Array.isArray(j?.data) ? j!.data! : [];
      if (results.length === 0) continue;
      const hit = results[0];

      // Map the search hit to our loose profile shape (display_name, headline,
      // location, photo, URL, provider id) so it prefills even without a second
      // call…
      const hitProfile: UnipileProfile = {
        display_name: hit.display_name,
        headline: hit.headline,
        location: hit.location,
        public_identifier: hit.public_identifier,
        profile_url: hit.profile_url,
        public_picture_url: hit.public_picture_url_large || hit.public_picture_url,
        provider_id: hit.id,
        id: hit.id,
      };

      // …then enrich via the public identifier to pull structured experience
      // (current title + company), merging the provider id/url back in.
      const slug = pickString(hit.public_identifier);
      if (slug) {
        const enriched = await v2GetUser(base, apiKey, acc, slug);
        if (enriched && hasUsefulProfile(enriched)) {
          return {
            ...hitProfile,
            ...enriched,
            provider_id: hitProfile.provider_id || enriched.provider_id,
            profile_url: enriched.profile_url || hitProfile.profile_url,
            public_identifier: enriched.public_identifier || hitProfile.public_identifier,
            public_picture_url: enriched.public_picture_url || hitProfile.public_picture_url,
          };
        }
      }
      return hasUsefulProfile(hitProfile) ? hitProfile : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** Recover a profile from a chat's messages (v2). v2 has no chat-attendees
 *  route, but each message carries the full `sender` User object. Take an
 *  inbound message's sender, then enrich it via the direct profile read when it
 *  exposes a public identifier — otherwise the sender object alone prefills. */
async function resolveFromChat(
  v2Base: string,
  apiKeyV2: string,
  v2AcctIds: string[],
  chatId: string,
): Promise<UnipileProfile | null> {
  const sender = await senderFromChatMessages(v2Base, apiKeyV2, v2AcctIds, chatId);
  if (!sender) return null;

  const slug = pickString(sender.public_identifier);
  if (slug) {
    for (const acc of v2AcctIds) {
      const p = await v2GetUser(v2Base, apiKeyV2, acc, slug);
      if (hasUsefulProfile(p)) return p;
    }
  }
  return hasUsefulProfile(sender) ? sender : null;
}

/** Read a chat's messages on the v2 host (trying each connected seat) and
 *  return the sender of an inbound message — i.e. the other party. */
async function senderFromChatMessages(
  v2Base: string,
  apiKeyV2: string,
  v2AcctIds: string[],
  chatId: string,
): Promise<UnipileProfile | null> {
  const headers = { "X-API-KEY": apiKeyV2, Accept: "application/json" };
  const cid = encodeURIComponent(chatId);
  for (const acc of v2AcctIds) {
    const r = await safeGet(`${v2Base}/${encodeURIComponent(acc)}/chats/${cid}/messages?limit=30`, headers);
    if (!r?.ok) continue;
    const j = (await r.json().catch(() => null)) as { data?: UnipileMessage[] } | null;
    const msgs = j?.data;
    if (!Array.isArray(msgs) || msgs.length === 0) continue;

    // Prefer a message we did NOT send; else one whose sender isn't us; else any.
    const pick =
      msgs.find((m) => m && m.is_sender === false && m.sender) ??
      msgs.find((m) => m?.sender && m.sender.specifics?.network_distance !== "SELF") ??
      msgs.find((m) => m?.sender);
    if (pick?.sender) return pick.sender;
  }
  return null;
}

/** GET a URL with a hard timeout; fail fast (null) so resolution falls through
 *  instead of hanging the wizard. */
async function safeGet(url: string, headers: Record<string, string>): Promise<Response | null> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
  } catch {
    return null;
  }
}

/** First non-empty trimmed string among the args (ignores non-strings). */
function pickString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return "";
}
