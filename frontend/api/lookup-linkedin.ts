import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/lookup-linkedin
 *
 * Fetches a LinkedIn profile via the Unipile **v2** API and normalizes it to
 * form-compatible fields for the Add Person wizard.
 *
 * Why v2: the v1 DSN key now points at a Unipile app with ZERO connected
 * accounts, so every v1 short-id call 404s "Account not found". The live
 * accounts are on the v2 host (api.unipile.com/v2), addressed by their canonical
 * `acc_xxx` id with the UNIPILE_API_KEY_V2 key — the same surface the rest of
 * the app already routes through (see src/server-lib/unipile-v2.ts). This
 * endpoint stays self-contained (inlined v2 calls, no shared import) so the
 * Vercel bundler can't drop the dependency.
 *
 * Resolution: any connected seat can read any public profile, so we try the
 * thread's own account first, then fall back across every other connected
 * account — one reconnected seat resolves profiles for all threads.
 *
 *   v2 route: GET {v2Base}/{acc_xxx}/users/{provider_id-or-slug}
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

  const { linkedin_url, unipile_id, integration_account_id, account_id } = req.body || {};
  if (!linkedin_url && !unipile_id) return res.status(200).json({});

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
    const accFromRow = (row: any) =>
      row?.unipile_account_id_v2 ?? row?.metadata?.unipile_account_id_v2 ?? null;

    if (account_id) pushAcc(account_id);
    if (integration_account_id) {
      const { data } = await supabase
        .from("integration_accounts")
        .select("unipile_account_id_v2, metadata")
        .eq("id", integration_account_id)
        .maybeSingle();
      pushAcc(accFromRow(data));
    }
    const { data: allAccts } = await supabase
      .from("integration_accounts")
      .select("unipile_account_id_v2, metadata")
      .eq("provider", "linkedin")
      .eq("is_active", true);
    for (const row of allAccts ?? []) pushAcc(accFromRow(row));

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
    if (ids.length === 0) return res.status(200).json({});

    // ── Try each identifier against each account until one resolves ──
    let profile: any = null;
    outer: for (const id of ids) {
      for (const acc of acctIds) {
        const p = await v2GetUser(v2Base, apiKeyV2, acc, id);
        if (p && (p.first_name || p.last_name || p.display_name)) {
          profile = p;
          break outer;
        }
      }
    }
    if (!profile) return res.status(200).json({});

    // ── Normalize the v2 UserProfile → the wizard's form fields ──
    const display = pickString(profile.display_name);
    const first = pickString(profile.first_name) || display.split(/\s+/)[0] || "";
    const last = pickString(profile.last_name) || display.split(/\s+/).slice(1).join(" ");

    // v2 surfaces the role line as `description` ("Title at Company"); split it
    // into structured title/company when possible (company drives the
    // people↔companies auto-link). Fall back to the whole string as the title.
    const description = pickString(profile.description);
    let title = "";
    let company = "";
    const split = description.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (split) {
      title = split[1].trim();
      company = split[2].trim();
    } else if (description) {
      title = description;
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
    const location = pickString(
      typeof profile.location === "string" ? profile.location : null,
      profile.location?.name,
    );
    const resolvedUrl =
      pickString(profile.profile_url) ||
      (profile.public_identifier ? `https://www.linkedin.com/in/${profile.public_identifier}` : "") ||
      (typeof linkedin_url === "string" ? linkedin_url : "");

    const result: Record<string, string> = {};
    if (first) result.first_name = first;
    if (last) result.last_name = last;
    const email = pickString(profile.email);
    if (email) result.email = email;
    if (phone) result.phone = phone;
    if (title) result.title = title;
    if (company) result.company_name = company;
    if (location) result.location = location;
    if (photo) result.photo = photo;
    if (resolvedUrl) result.linkedin_url = resolvedUrl;

    return res.status(200).json(result);
  } catch (err) {
    console.error("LinkedIn lookup failed:", err);
    return res.status(200).json({});
  }
}

/** GET a Unipile v2 user profile, failing fast (null) on any error/timeout so
 *  resolution falls through to the next id/account instead of hanging the
 *  Add Person wizard. */
async function v2GetUser(
  base: string,
  apiKey: string,
  acc: string,
  id: string,
): Promise<any | null> {
  try {
    const r = await fetch(
      `${base}/${encodeURIComponent(acc)}/users/${encodeURIComponent(id)}`,
      { headers: { "X-API-KEY": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(9000) },
    );
    if (!r.ok) return null;
    return await r.json();
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
