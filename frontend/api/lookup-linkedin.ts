import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/lookup-linkedin
 *
 * Fetches a LinkedIn profile via the Unipile API and normalizes it to
 * form-compatible fields for the Add Person wizard.
 *
 * Body: { linkedin_url?, unipile_id?, account_id? }
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

  const { linkedin_url, unipile_id, account_id } = req.body || {};
  if (!linkedin_url && !unipile_id) return res.status(200).json({});

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

    // Get a Unipile account ID if not provided
    let acctId = account_id;
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

    let profileData: any = null;

    // Try direct fetch by Unipile ID
    if (unipile_id) {
      const r = await fetch(`${baseUrl}/api/v1/users/${unipile_id}?account_id=${acctId}`, {
        headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      });
      if (r.ok) profileData = await r.json();
    }

    // Try resolving by LinkedIn URL slug
    if (!profileData && linkedin_url) {
      const match = linkedin_url.match(/linkedin\.com\/in\/([^/?#]+)/);
      const slug = match?.[1];
      if (slug) {
        const r = await fetch(`${baseUrl}/api/v1/users/${slug}?account_id=${acctId}`, {
          headers: { "X-API-KEY": apiKey, Accept: "application/json" },
        });
        if (r.ok) profileData = await r.json();
      }
    }

    if (!profileData) return res.status(200).json({});

    // Normalize to form-compatible fields
    const result: Record<string, string> = {};
    if (profileData.first_name) result.first_name = profileData.first_name;
    if (profileData.last_name) result.last_name = profileData.last_name;
    if (profileData.email) result.email = profileData.email;
    if (profileData.phone || profileData.phone_number)
      result.phone = profileData.phone || profileData.phone_number;
    if (profileData.headline || profileData.title)
      result.title = profileData.headline || profileData.title;
    if (profileData.company || profileData.company_name)
      result.company_name = profileData.company || profileData.company_name;
    if (profileData.location || profileData.region)
      result.location = profileData.location || profileData.region;
    if (profileData.public_profile_url)
      result.linkedin_url = profileData.public_profile_url;
    else if (linkedin_url)
      result.linkedin_url = linkedin_url;

    return res.status(200).json(result);
  } catch (err) {
    console.error("LinkedIn lookup failed:", err);
    return res.status(200).json({});
  }
}
