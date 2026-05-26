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
    // Resolve v2 base URL + key.
    const [{ data: v2Row }, { data: v2KeyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    ]);
    const v2Base = (v2Row?.value || "").replace(/\/+$/, "")
      || "https://api.unipile.com/v2";
    const apiKey = v2KeyRow?.value;
    if (!v2Base || !apiKey) {
      console.error("Unipile v2 config not found in app_settings");
      return res.status(200).json({});
    }

    // Resolve a Unipile account ID (prefer v2 acc_xxx from metadata).
    let acctId = account_id;
    if (!acctId && integration_account_id) {
      const { data: ia } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id, metadata")
        .eq("id", integration_account_id)
        .maybeSingle();
      acctId = (ia?.metadata?.unipile_account_id_v2 || ia?.unipile_account_id) ?? undefined;
    }
    if (!acctId) {
      const { data: accounts } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id, metadata")
        .not("unipile_account_id", "is", null)
        .eq("is_active", true)
        .limit(1);
      const row = accounts?.[0];
      acctId = (row?.metadata?.unipile_account_id_v2 || row?.unipile_account_id) ?? undefined;
    }
    if (!acctId) {
      console.warn("No active Unipile account found");
      return res.status(200).json({});
    }

    const uniHeaders = { "X-API-KEY": apiKey, Accept: "application/json" };
    const acctParam = encodeURIComponent(acctId);
    let profileData: any = null;
    let attendeeData: any = null;

    // Try direct fetch by Unipile ID — v2: GET /v2/{acct}/linkedin/users/{id}
    if (unipile_id) {
      const r = await fetch(
        `${v2Base}/${acctParam}/linkedin/users/${encodeURIComponent(unipile_id)}`,
        { headers: uniHeaders },
      );
      if (r.ok) profileData = await r.json();
    }

    // Try resolving by LinkedIn URL slug — v2: GET /v2/{acct}/linkedin/users/{slug}
    if (!profileData && linkedin_url) {
      const match = linkedin_url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/);
      const slug = match?.[1];
      if (slug) {
        const r = await fetch(
          `${v2Base}/${acctParam}/linkedin/users/${encodeURIComponent(slug)}`,
          { headers: uniHeaders },
        );
        if (r.ok) profileData = await r.json();
      }
    }

    // Try resolving via chat attendees — v2: GET /v2/{acct}/chats/{id}
    // (attendees are inline in the v2 chat response)
    if (!profileData && chat_id) {
      let attendees: any[] = [];
      const chatResp = await fetch(
        `${v2Base}/${acctParam}/chats/${encodeURIComponent(chat_id)}`,
        { headers: uniHeaders },
      );
      if (chatResp.ok) {
        const chatJson: any = await chatResp.json();
        attendees = chatJson.attendees ?? chatJson.members ?? chatJson.participants ?? [];
      }

      const other = attendees.find(
        (a: any) => a.provider_id !== acctId && a.id !== acctId,
      ) ?? attendees[0];

      if (other) {
        attendeeData = other;
        const providerId = other.provider_id ?? other.id;
        if (providerId) {
          const r = await fetch(
            `${v2Base}/${acctParam}/linkedin/users/${encodeURIComponent(providerId)}`,
            { headers: uniHeaders },
          );
          if (r.ok) profileData = await r.json();
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
        public_profile_url:
          attendeeData.public_profile_url ??
          attendeeData.profile_url ??
          attendeeData.url ??
          undefined,
      };
    }

    if (!profileData) return res.status(200).json({});

    // Pull current title + company straight from Unipile's structured fields.
    // Order: experience[0] / work_experience[0] (most-recent-first array) →
    // flat current_* fields → flat title/company fields. We do NOT parse the
    // headline string; the headline is a marketing tagline, not the job title.
    const expArray =
      (Array.isArray(profileData.experience) && profileData.experience) ||
      (Array.isArray(profileData.work_experience) && profileData.work_experience) ||
      [];
    const currentExp = expArray.length > 0 ? expArray[0] : null;
    const currentTitle =
      currentExp?.title ||
      currentExp?.position ||
      profileData.current_position ||
      profileData.current_title ||
      profileData.title ||
      "";
    const currentCompany =
      currentExp?.company ||
      currentExp?.company_name ||
      currentExp?.organization ||
      profileData.current_company ||
      profileData.company ||
      profileData.company_name ||
      "";

    // Normalize to form-compatible fields
    const result: Record<string, string> = {};
    if (profileData.first_name) result.first_name = profileData.first_name;
    if (profileData.last_name) result.last_name = profileData.last_name;
    // Unipile returns contact_info.emails as an array for full profiles
    const emailFromContact = Array.isArray(profileData?.contact_info?.emails)
      ? profileData.contact_info.emails[0]
      : null;
    if (profileData.email || emailFromContact) {
      result.email = profileData.email || emailFromContact;
    }
    if (profileData.phone || profileData.phone_number) {
      result.phone = profileData.phone || profileData.phone_number;
    }
    if (currentTitle) result.title = currentTitle;
    if (currentCompany) result.company_name = currentCompany;
    if (profileData.location || profileData.region || profileData.location_name) {
      result.location = profileData.location || profileData.region || profileData.location_name;
    }
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
