import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * Resolve one person's LinkedIn URL → Unipile provider_id immediately
 * after insert, instead of waiting for the every-2h cron. Uses the v1
 * tenant DSN at /api/v1/users/{slug}?account_id=X — our v2 app key
 * returns 403 on the v2 equivalent (/v2/{acct}/linkedin/users/{slug}).
 *
 * On success writes provider_id back to people.unipile_provider_id and
 * sets unipile_resolve_status='resolved'. On failure flips the status
 * to 'not_found' or 'pending' (so the cron retries) and 200s back —
 * never throws so callers can fire-and-forget.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { person_id } = req.body ?? {};
  if (!person_id) {
    return res.status(400).json({ error: "Missing person_id" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    // 1. Fetch the person + a LinkedIn account to scope the v1 call.
    const [{ data: person }, { data: accounts }, { data: v1BaseRow }, { data: v1KeyRow }] = await Promise.all([
      supabase
        .from("people")
        .select("id, linkedin_url, unipile_resolve_status")
        .eq("id", person_id)
        .maybeSingle(),
      supabase
        .from("integration_accounts")
        .select("id, unipile_account_id, account_type")
        .or("account_type.eq.linkedin_recruiter,account_type.eq.linkedin_classic,account_type.eq.linkedin")
        .eq("is_active", true)
        .not("unipile_account_id", "is", null)
        .order("account_type", { ascending: false })
        .limit(1),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
    ]);

    if (!person) return res.status(404).json({ error: "Person not found" });
    if (!person.linkedin_url) {
      return res.status(200).json({ resolved: false, reason: "no_linkedin_url" });
    }
    const account = accounts?.[0];
    if (!account?.unipile_account_id) {
      return res.status(200).json({ resolved: false, reason: "no_unipile_account" });
    }
    const v1Base = (v1BaseRow?.value || "").replace(/\/+$/, "")
      || "https://api19.unipile.com:14926/api/v1";
    const v1Key = v1KeyRow?.value;
    if (!v1Base || !v1Key) {
      return res.status(200).json({ resolved: false, reason: "unipile_not_configured" });
    }

    // 2. Extract slug, hit Unipile v1.
    const match = person.linkedin_url.match(/linkedin\.com\/in\/([^/?#]+)/);
    const slug = match ? match[1] : (/^[\w-]+$/.test(person.linkedin_url.trim()) ? person.linkedin_url.trim() : null);
    if (!slug) {
      await supabase.from("people").update({ unipile_resolve_status: "invalid_url" } as any).eq("id", person_id);
      return res.status(200).json({ resolved: false, reason: "invalid_url" });
    }

    const url = `${v1Base}/users/${encodeURIComponent(slug)}?account_id=${encodeURIComponent(account.unipile_account_id)}`;
    const resp = await fetch(url, {
      headers: { "X-API-KEY": v1Key, Accept: "application/json", "X-UNIPILE-CLIENT": "sully-recruit" },
    });

    if (!resp.ok) {
      // Soft-fail: leave status='pending' so the cron retries on its own.
      // 404 means Unipile genuinely can't see the profile; mark as such
      // so we don't keep retrying on the cron either.
      const newStatus = resp.status === 404 ? "not_found" : "pending";
      await supabase.from("people").update({ unipile_resolve_status: newStatus } as any).eq("id", person_id);
      return res.status(200).json({
        resolved: false,
        reason: `unipile_${resp.status}`,
        status: newStatus,
      });
    }

    const profile = await resp.json();
    const providerId = profile.provider_id ?? profile.public_identifier ?? null;
    const unipileId = profile.id ?? null;
    if (!providerId && !unipileId) {
      await supabase.from("people").update({ unipile_resolve_status: "no_ids" } as any).eq("id", person_id);
      return res.status(200).json({ resolved: false, reason: "no_ids_in_response" });
    }

    // 3. Cache to people. The right typed column depends on the account
    //    flavour so live sends pick the matching id.
    const idColumn = account.account_type === "linkedin_recruiter"
      ? "unipile_recruiter_id"
      : account.account_type === "linkedin_classic"
        ? "unipile_classic_id"
        : "unipile_recruiter_id";
    const enrichment: Record<string, any> = {
      [idColumn]: providerId ?? unipileId,
      unipile_provider_id: providerId,
      unipile_resolve_status: "resolved",
      linkedin_profile_data: profile,
    };
    if (profile.headline) enrichment.linkedin_headline = profile.headline;
    const avatarUrl = profile.profile_picture_url ?? profile.picture_url ?? profile.image_url ?? null;
    if (avatarUrl) enrichment.avatar_url = avatarUrl;

    await supabase.from("people").update(enrichment as any).eq("id", person_id);

    return res.status(200).json({ resolved: true, provider_id: providerId, unipile_id: unipileId });
  } catch (err: any) {
    console.error("resolve-person-now error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
