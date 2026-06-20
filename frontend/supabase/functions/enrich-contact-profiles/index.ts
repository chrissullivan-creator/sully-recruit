import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractSlug(url: string): string | null {
  const m = (url ?? "").replace(/\/+$/, "").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  return m?.[1] ?? null;
}

function extractFields(profile: Record<string, any>): {
  title: string | null; company: string | null; headline: string | null;
  location: string | null; avatar_url: string | null; phone: string | null; department: string | null;
} {
  const headline = profile.headline ?? profile.occupation ?? null;
  const location = profile.location ?? profile.geo?.full ?? profile.geoLocationName ?? null;
  const avatar_url =
    profile.profile_picture_url ?? profile.picture_url ?? profile.image_url ??
    profile.photoUrl ?? profile.profilePicture?.displayImage ?? null;

  let title: string | null = null, company: string | null = null, department: string | null = null;

  if (Array.isArray(profile.experience) && profile.experience.length > 0) {
    const current = profile.experience.find((e: any) => !e.end_date && !e.ends_at) ?? profile.experience[0];
    title = current?.title ?? current?.role ?? null;
    company = current?.company_name ?? current?.company ?? current?.companyName ?? null;
    department = current?.department ?? null;
  }
  if (!title && Array.isArray(profile.positions?.positionView?.elements)) {
    const pos = profile.positions.positionView.elements[0];
    title = pos?.title ?? null;
    company = pos?.companyName ?? pos?.company?.name ?? null;
  }
  if (!title && headline) {
    const atIdx = headline.toLowerCase().lastIndexOf(" at ");
    if (atIdx > 0) { title = headline.slice(0, atIdx).trim(); company = company ?? headline.slice(atIdx + 4).trim(); }
    else { title = headline; }
  }

  let phone: string | null = null;
  if (Array.isArray(profile.contact_info?.phones) && profile.contact_info.phones.length > 0)
    phone = profile.contact_info.phones[0]?.number ?? profile.contact_info.phones[0] ?? null;
  else if (profile.phoneNumbers?.length)
    phone = profile.phoneNumbers[0]?.number ?? null;

  return { title, company, headline, location, avatar_url, phone, department };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "POST only" }, 405);

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));

    // Read V2 credentials from app_settings — same source as resolve-person-now.ts
    const { data: settingsRows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["UNIPILE_BASE_V2_URL", "UNIPILE_API_KEY_V2"]);
    const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value]));
    const v2Base = (settings["UNIPILE_BASE_V2_URL"] ?? "").replace(/\/+$/, "");
    const v2Key = settings["UNIPILE_API_KEY_V2"] ?? "";

    if (!v2Base) throw new Error("UNIPILE_BASE_V2_URL not found in app_settings");
    if (!v2Key) throw new Error("UNIPILE_API_KEY_V2 not found in app_settings");

    const contact_ids: string[] = body.contact_ids ?? [];
    const limit = Math.min(body.limit ?? 60, 200);
    const dry_run = body.dry_run ?? false;
    const debug = body.debug ?? false;

    // Load LinkedIn accounts — recruiter first
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, account_type, linkedin_capability")
      .eq("provider", "linkedin").eq("is_active", true)
      .not("unipile_account_id", "is", null);

    const allAccounts = accounts ?? [];
    if (allAccounts.length === 0) throw new Error("No active LinkedIn accounts found");

    const priority = ["recruiter", "sales_nav", "classic"];
    const sorted = [...allAccounts].sort((a, b) => {
      const ai = priority.indexOf(a.linkedin_capability ?? "");
      const bi = priority.indexOf(b.linkedin_capability ?? "");
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    console.log(`[enrich-contact-profiles] v2_base=${v2Base} accounts=${sorted.map(a => a.linkedin_capability ?? a.account_type).join(",")}`);

    let query = supabase
      .from("contacts")
      .select("id, full_name, linkedin_url, title, company_name, linkedin_current_title, phone, mobile_phone, avatar_url")
      .not("linkedin_url", "is", null).neq("linkedin_url", "");

    if (contact_ids.length > 0) query = query.in("id", contact_ids);
    else query = query.is("linkedin_current_title", null).limit(limit);

    const { data: contacts, error: qErr } = await query;
    if (qErr) throw qErr;

    if (dry_run) {
      return respond({
        dry_run: true, contacts_to_process: contacts?.length ?? 0,
        v2_base: v2Base, key_prefix: v2Key.slice(0, 8),
        sample: contacts?.slice(0, 5).map((c) => c.full_name),
        accounts: sorted.map(a => `${a.linkedin_capability ?? a.account_type} (${a.unipile_account_id})`),
      });
    }

    // DEBUG: test v2 endpoint for first contact across all accounts
    if (debug && contacts && contacts.length > 0) {
      const c = contacts[0];
      const slug = extractSlug(c.linkedin_url ?? "");
      const debugResults: Record<string, any>[] = [];
      for (const acct of sorted) {
        // V2 endpoint: {base}/{account_id}/linkedin/users/{slug}
        const url = `${v2Base}/${encodeURIComponent(acct.unipile_account_id)}/linkedin/users/${encodeURIComponent(slug ?? "")}`;
        try {
          const res = await fetch(url, {
            headers: { "X-API-KEY": v2Key, Accept: "application/json", "X-UNIPILE-CLIENT": "sully-recruit" },
            signal: AbortSignal.timeout(10000),
          });
          const text = await res.text();
          let parsed: any;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          debugResults.push({
            account: acct.linkedin_capability ?? acct.account_type,
            url, http_status: res.status,
            response_keys: typeof parsed === 'object' && parsed ? Object.keys(parsed) : null,
            preview: JSON.stringify(parsed).slice(0, 500),
          });
        } catch (e: any) {
          debugResults.push({ account: acct.linkedin_capability ?? acct.account_type, url, error: e.message.slice(0, 120) });
        }
        await sleep(300);
      }
      return respond({ debug: true, contact: c.full_name, slug, v2_base: v2Base, key_prefix: v2Key.slice(0, 8), results: debugResults });
    }

    let enriched = 0, skipped = 0, failed = 0;
    const results: Record<string, any>[] = [];

    for (const contact of contacts ?? []) {
      const slug = extractSlug(contact.linkedin_url ?? "");
      if (!slug || slug.startsWith("ACo") || slug.startsWith("ACw")) {
        skipped++; results.push({ id: contact.id, name: contact.full_name, status: "skipped", reason: "bad_slug" }); continue;
      }

      let profileData: Record<string, any> | null = null;
      let enrichmentSource = "";

      for (const acct of sorted) {
        try {
          // V2 endpoint: account_id in path, not query param
          const url = `${v2Base}/${encodeURIComponent(acct.unipile_account_id)}/linkedin/users/${encodeURIComponent(slug)}`;
          const res = await fetch(url, {
            headers: { "X-API-KEY": v2Key, Accept: "application/json", "X-UNIPILE-CLIENT": "sully-recruit" },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) { console.log(`[enrich] ${contact.full_name}/${acct.linkedin_capability}: HTTP ${res.status}`); continue; }
          const data = await res.json();
          if (data?.is_self === true) continue;
          if (data && (data.first_name || data.headline || data.occupation || data.provider_id)) {
            profileData = data; enrichmentSource = acct.linkedin_capability ?? acct.account_type ?? "unipile"; break;
          }
        } catch (e: any) { console.log(`[enrich] ${contact.full_name}/${acct.linkedin_capability}: ${e.message.slice(0,80)}`); }
        await sleep(300);
      }

      if (!profileData) {
        failed++; results.push({ id: contact.id, name: contact.full_name, status: "failed", reason: "no_profile" });
        await sleep(400); continue;
      }

      const { title, company, headline, location, avatar_url, phone, department } = extractFields(profileData);

      // NEVER touch email, work_email, secondary_emails
      const update: Record<string, any> = {
        linkedin_profile_data: JSON.stringify(profileData),
        linkedin_enriched_at: new Date().toISOString(),
        linkedin_enrichment_source: enrichmentSource,
        updated_at: new Date().toISOString(),
      };
      if (headline !== null) update.linkedin_headline = headline;
      if (location !== null) update.linkedin_location = location;
      if (title !== null) update.linkedin_current_title = title;
      if (company !== null) update.linkedin_current_company = company;
      if (!contact.title && title) update.title = title;
      if (!contact.company_name && company) update.company_name = company;
      if (!contact.avatar_url && avatar_url) update.avatar_url = avatar_url;
      if (!contact.phone && !contact.mobile_phone && phone) update.mobile_phone = phone;
      if (location) update.location = location;
      if (department) update.department = department;

      // Also store provider_id for future messaging use
      const providerId = profileData.provider_id ?? profileData.public_identifier ?? null;
      if (providerId) {
        const col = enrichmentSource === "recruiter" ? "unipile_recruiter_id" : "unipile_classic_id";
        update[col] = providerId;
      }

      const { error: updErr } = await supabase.from("contacts").update(update).eq("id", contact.id);
      if (updErr) {
        failed++; results.push({ id: contact.id, name: contact.full_name, status: "failed", reason: updErr.message });
      } else {
        enriched++;
        results.push({
          id: contact.id, name: contact.full_name, status: "enriched", source: enrichmentSource,
          title, company, headline, location, has_avatar: !!avatar_url, has_phone: !!phone, department,
        });
      }
      await sleep(500);
    }

    return respond({ success: true, enriched, skipped, failed, total: (contacts ?? []).length, results });

  } catch (err: unknown) {
    console.error("[enrich-contact-profiles]", err);
    return respond({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
