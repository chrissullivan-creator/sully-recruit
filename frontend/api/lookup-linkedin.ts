import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/lookup-linkedin
 *
 * Fetches a LinkedIn profile via the Unipile **v1** API and normalizes
 * it to form-compatible fields for the Add Person wizard.
 *
 *   v1 paths (account_id is a query parameter, not a path segment):
 *     GET /api/v1/users/{slug-or-provider-id}?account_id=X
 *     GET /api/v1/chats/{chat_id}?account_id=X
 *     GET /api/v1/chats/{chat_id}/attendees?account_id=X
 *
 * Resolution order (first hit wins):
 *   1. unipile_id           — direct user fetch
 *   2. linkedin_url         — slug extracted from URL
 *   3. chat_id              — fetch chat attendees, pick the "other" one
 *
 * Body: { linkedin_url?, unipile_id?, chat_id?, integration_account_id?, account_id? }
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

  const { linkedin_url, unipile_id, chat_id, integration_account_id, account_id } = req.body || {};
  if (!linkedin_url && !unipile_id && !chat_id) return res.status(200).json({});

  try {
    // Resolve v1 tenant DSN + key. Our v2 app key returns 403 on
    // /linkedin/users/{slug}, so we use the v1 surface where the
    // equivalent route is /users/{slug}?account_id=X.
    const [{ data: v1Row }, { data: v1KeyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
    ]);
    const v1Base = (v1Row?.value || "").replace(/\/+$/, "")
      || "https://api19.unipile.com:14926/api/v1";
    const apiKey = v1KeyRow?.value;
    if (!v1Base || !apiKey) {
      console.error("Unipile v1 config not found in app_settings");
      return res.status(200).json({});
    }

    // Resolve a Unipile account ID — prefer the one associated with this thread's
    // integration_account, falling back to any active account.
    let acctId = account_id;
    if (!acctId && integration_account_id) {
      const { data: ia } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id")
        .eq("id", integration_account_id)
        .maybeSingle();
      acctId = ia?.unipile_account_id ?? undefined;
    }
    if (!acctId) {
      const { data: accounts } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id")
        .not("unipile_account_id", "is", null)
        .eq("is_active", true)
        .limit(1);
      acctId = accounts?.[0]?.unipile_account_id;
    }
    if (!acctId) {
      console.warn("No active Unipile account found");
      return res.status(200).json({});
    }

    const uniHeaders = { "X-API-KEY": apiKey, Accept: "application/json" };
    const acctParam = encodeURIComponent(acctId);
    let profileData: any = null;
    let attendeeData: any = null;

    // Try direct fetch by Unipile ID — v1: /users/{id}?account_id=X
    if (unipile_id) {
      const r = await uniGet(
        `${v1Base}/users/${encodeURIComponent(unipile_id)}?account_id=${acctParam}`,
        uniHeaders,
      );
      if (r?.ok) profileData = await r.json();
    }

    // Try resolving by LinkedIn URL slug — v1: /users/{slug}?account_id=X
    if (!profileData && linkedin_url) {
      const match = linkedin_url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/);
      const slug = match?.[1];
      if (slug) {
        const r = await uniGet(
          `${v1Base}/users/${encodeURIComponent(slug)}?account_id=${acctParam}`,
          uniHeaders,
        );
        if (r?.ok) profileData = await r.json();
      }
    }

    // Try resolving via chat attendees — used when the inbound message has no
    // LinkedIn URL (common: backfill-populated LinkedIn threads store only the
    // Unipile provider_id, not a URL).
    //   v1: /chats/{id}?account_id=X and /chats/{id}/attendees?account_id=X
    if (!profileData && chat_id) {
      let attendees: any[] = [];
      const chatResp = await uniGet(
        `${v1Base}/chats/${encodeURIComponent(chat_id)}?account_id=${acctParam}`,
        uniHeaders,
      );
      if (chatResp?.ok) {
        const chatJson: any = await chatResp.json();
        attendees = chatJson.attendees ?? chatJson.members ?? chatJson.participants ?? [];
      }
      if (attendees.length === 0) {
        const attResp = await uniGet(
          `${v1Base}/chats/${encodeURIComponent(chat_id)}/attendees?account_id=${acctParam}`,
          uniHeaders,
        );
        if (attResp?.ok) {
          const attJson: any = await attResp.json();
          attendees = attJson.items ?? attJson.attendees ?? [];
        }
      }

      const other = attendees.find(
        (a: any) => a.provider_id !== acctId && a.id !== acctId,
      ) ?? attendees[0];

      if (other) {
        attendeeData = other;
        const providerId = other.provider_id ?? other.id;
        if (providerId) {
          const r = await uniGet(
            `${v1Base}/users/${encodeURIComponent(providerId)}?account_id=${acctParam}`,
            uniHeaders,
          );
          if (r?.ok) profileData = await r.json();
        }
      }
    }

    // If we couldn't get a full profile but do have attendee data, synthesize
    // a minimal profile so the form still gets something useful.
    if (!profileData && attendeeData) {
      const name = attendeeData.display_name ?? attendeeData.name ?? "";
      const parts = name.trim().split(/\s+/);
      profileData = {
        first_name: parts[0] ?? "",
        last_name: parts.slice(1).join(" "),
        headline: attendeeData.headline ?? attendeeData.title ?? undefined,
        company: attendeeData.company ?? attendeeData.current_company ?? attendeeData.company_name ?? attendeeData.organization ?? undefined,
        location: attendeeData.location ?? undefined,
        profile_picture_url:
          attendeeData.profile_picture_url ?? attendeeData.picture_url ?? undefined,
        public_profile_url:
          attendeeData.public_profile_url ??
          attendeeData.profile_url ??
          attendeeData.url ??
          undefined,
      };
    }

    if (!profileData) return res.status(200).json({});

    // Extract structured profile fields. Mirrors the canonical enrichment
    // logic in api/lib/linkedin-finder.ts so the manual "Add Person" path
    // and the background Unipile resolver agree on title / company /
    // location / headline / photo. We do NOT parse the headline string for
    // a job title — the headline is a marketing tagline, not the position.
    const expArray: any[] =
      (Array.isArray(profileData.positions) && profileData.positions) ||
      (Array.isArray(profileData.experience) && profileData.experience) ||
      (Array.isArray(profileData.work_experience) && profileData.work_experience) ||
      [];
    // Prefer the entry flagged current (or with no end date); most-recent-
    // first ordering isn't guaranteed across Unipile account types.
    const currentExp =
      expArray.find(
        (e: any) => e?.is_current || e?.current || (!e?.end_date && !e?.end && !e?.ends_at && !e?.to),
      ) ?? expArray[0] ?? null;

    const currentTitle = pickString(
      currentExp?.title,
      currentExp?.position,
      currentExp?.role,
      profileData.current_position,
      profileData.current_title,
      profileData.title,
    );
    const currentCompany = pickString(
      typeof currentExp?.company === "string" ? currentExp.company : null,
      currentExp?.company?.name,
      currentExp?.company_name,
      currentExp?.organization,
      profileData.current_company,
      profileData.company,
      profileData.company_name,
    );
    const location = pickString(
      profileData.location,
      profileData.location?.name,
      profileData.location?.display_name,
      profileData.region,
      profileData.location_name,
    );
    const headline = pickString(profileData.headline);
    // picture_url / image_url are additional fallbacks for the same field
    // (matches resolve-unipile-ids.ts + linkedin-finder.ts) so every path
    // lands a consistent avatar.
    const photo = pickString(
      profileData.profile_picture_url,
      profileData.profile_picture_url_large,
      profileData.picture_url,
      profileData.image_url,
      profileData.photo_url,
      profileData.avatar_url,
    );

    // Normalize to form-compatible fields
    const result: Record<string, string> = {};
    if (profileData.first_name) result.first_name = profileData.first_name;
    if (profileData.last_name) result.last_name = profileData.last_name;
    // Unipile returns contact_info.emails / .phones as arrays (of strings
    // or objects) for full profiles; fall back to flat fields otherwise.
    const email = pickString(
      profileData.email,
      firstFromArray(profileData?.contact_info?.emails, ["email", "address"]),
    );
    if (email) result.email = email;
    const phone = pickString(
      profileData.phone,
      profileData.phone_number,
      firstFromArray(profileData?.contact_info?.phones, ["number", "phone"]),
    );
    if (phone) result.phone = phone;
    if (currentTitle) result.title = currentTitle;
    if (currentCompany) result.company_name = currentCompany;
    if (location) result.location = location;
    if (headline) result.headline = headline;
    if (photo) result.photo = photo;
    // Prefer a real URL over whatever the caller handed us; fall back to
    // constructing one from public_identifier if needed.
    if (profileData.public_profile_url) {
      result.linkedin_url = profileData.public_profile_url;
    } else if (profileData.public_identifier) {
      result.linkedin_url = `https://www.linkedin.com/in/${profileData.public_identifier}`;
    } else if (linkedin_url) {
      result.linkedin_url = linkedin_url;
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("LinkedIn lookup failed:", err);
    return res.status(200).json({});
  }
}

/** GET a Unipile URL with a hard timeout. The classic v1 chat/user endpoints
 *  don't serve LinkedIn Recruiter (RECRUITER_*) chats / AEM member ids and can
 *  hang, which would freeze the Add Person wizard's enrich step — so fail fast
 *  (return null) and let resolution fall through to the next strategy. */
async function uniGet(url: string, headers: Record<string, string>): Promise<Response | null> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
  } catch {
    return null;
  }
}

/** First non-empty trimmed string among the args (ignores non-strings, so
 *  an object-shaped `location` falls through to the next candidate). */
function pickString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return "";
}

/** First usable string from an array whose items may be plain strings or
 *  objects carrying the value under one of `keys` (e.g. Unipile's
 *  contact_info.emails / .phones). */
function firstFromArray(arr: unknown, keys: string[]): string | null {
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      for (const k of keys) {
        const v = (item as Record<string, unknown>)[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return null;
}
