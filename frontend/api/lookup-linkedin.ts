import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/lookup-linkedin
 *
 * Fetches a LinkedIn profile via the Unipile API and normalizes it to
 * form-compatible fields for the Add Person wizard.
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
    // Get Unipile config from app_settings table
    const { data: apiUrlRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "UNIPILE_BASE_URL")
      .single();
    const { data: apiKeyRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "UNIPILE_API_KEY")
      .single();

    const baseUrl = apiUrlRow?.value;
    const apiKey = apiKeyRow?.value;
    if (!baseUrl || !apiKey) {
      console.error("Unipile config not found in app_settings");
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
    // UNIPILE_BASE_URL already contains /api/v1 — don't double-prefix it.
    const apiBase = baseUrl.replace(/\/+$/, "");
    let profileData: any = null;
    let attendeeData: any = null;

    // Try direct fetch by Unipile ID
    if (unipile_id) {
      const r = await fetch(
        `${apiBase}/users/${encodeURIComponent(unipile_id)}?account_id=${acctId}`,
        { headers: uniHeaders },
      );
      if (r.ok) profileData = await r.json();
    }

    // Try resolving by LinkedIn URL slug
    if (!profileData && linkedin_url) {
      const match = linkedin_url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/);
      const slug = match?.[1];
      if (slug) {
        const r = await fetch(
          `${apiBase}/users/${encodeURIComponent(slug)}?account_id=${acctId}`,
          { headers: uniHeaders },
        );
        if (r.ok) profileData = await r.json();
      }
    }

    // Try resolving via chat attendees — used when the inbound message has no
    // LinkedIn URL (common: backfill-populated LinkedIn threads store only the
    // Unipile provider_id, not a URL).
    if (!profileData && chat_id) {
      // Unipile's /chats/{id} response typically embeds attendees; we also
      // try /chats/{id}/attendees as a backup.
      let attendees: any[] = [];
      const chatResp = await fetch(
        `${apiBase}/chats/${encodeURIComponent(chat_id)}?account_id=${acctId}`,
        { headers: uniHeaders },
      );
      if (chatResp.ok) {
        const chatJson: any = await chatResp.json();
        attendees = chatJson.attendees ?? chatJson.members ?? chatJson.participants ?? [];
      }
      if (attendees.length === 0) {
        const attResp = await fetch(
          `${apiBase}/chats/${encodeURIComponent(chat_id)}/attendees?account_id=${acctId}`,
          { headers: uniHeaders },
        );
        if (attResp.ok) {
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
          const r = await fetch(
            `${apiBase}/users/${encodeURIComponent(providerId)}?account_id=${acctId}`,
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

    // Unipile profiles bundle the current role in experience[0] (the array is
    // ordered most-recent-first). Pull title + company from there if present,
    // falling back to flat fields when we only have attendee-synthesized data.
    const currentExp = Array.isArray(profileData.experience) && profileData.experience.length > 0
      ? profileData.experience[0]
      : null;
    const currentTitle =
      currentExp?.title ||
      currentExp?.position ||
      profileData.current_position ||
      profileData.current_title ||
      profileData.title ||
      profileData.headline ||
      "";
    let currentCompany =
      currentExp?.company ||
      currentExp?.company_name ||
      profileData.current_company ||
      profileData.company ||
      profileData.company_name ||
      "";

    // Fallback: many LinkedIn headlines embed the company as "Title at Company".
    // For non-premium / attendee-synthesized profiles, that's our best shot.
    if (!currentCompany && profileData.headline) {
      const m = String(profileData.headline).match(/\s+(?:at|@|\|)\s+([^|·•]+?)\s*(?:\||·|•|$)/i);
      if (m) currentCompany = m[1].trim();
    }
    // Also try work_experience (some Unipile responses use this name).
    if (!currentCompany && Array.isArray(profileData.work_experience) && profileData.work_experience.length > 0) {
      const w = profileData.work_experience[0];
      currentCompany = w?.company || w?.company_name || w?.organization || "";
    }

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
