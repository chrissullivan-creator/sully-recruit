import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting, getUnipileBaseUrl } from "./lib/supabase";
import { delay } from "./lib/resume-parsing";

// Enrich candidates and contacts with LinkedIn profile embeddings.
//
// Schedules (create in Trigger.dev Dashboard, same task, different payloads):
//   Candidates: every 2 min   payload: { limit: 20, entity: "candidates", fetch_fresh: false }
//   Contacts:   every 3 min   payload: { limit: 20, entity: "contacts", fetch_fresh: false }
//   Fresh:      every 10 min  payload: { limit: 10, entity: "both", fetch_fresh: true }

const VOYAGE_MODEL = "voyage-finance-2";

async function getEmbedding(text: string, voyageKey: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

function buildLinkedInText(profile: Record<string, any>, entityName?: string): string {
  const parts: string[] = [];

  const name = entityName || [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  if (name) parts.push(`Name: ${name}`);
  if (profile.headline) parts.push(`Headline: ${profile.headline}`);
  if (profile.location) parts.push(`Location: ${profile.location}`);
  if (profile.summary || profile.about) parts.push(`About: ${profile.summary || profile.about}`);
  if (profile.current_position) parts.push(`Current Role: ${profile.current_position}`);

  if (Array.isArray(profile.skills) && profile.skills.length > 0) {
    const skillNames = profile.skills
      .map((s: any) => (typeof s === "string" ? s : s.name || s.skill_name || ""))
      .filter(Boolean);
    if (skillNames.length) parts.push(`Skills: ${skillNames.join(", ")}`);
  }

  if (Array.isArray(profile.experience) && profile.experience.length > 0) {
    const expLines = profile.experience
      .map((e: any) => {
        const p: string[] = [];
        if (e.title) p.push(e.title);
        if (e.company || e.company_name) p.push(`at ${e.company || e.company_name}`);
        if (e.start_date || e.date_range) p.push(`(${e.date_range || e.start_date})`);
        if (e.description) p.push(`- ${String(e.description).slice(0, 300)}`);
        return p.join(" ");
      })
      .filter(Boolean);
    if (expLines.length) parts.push(`Experience:\n${expLines.join("\n")}`);
  }

  if (Array.isArray(profile.education) && profile.education.length > 0) {
    const eduLines = profile.education
      .map((e: any) => [e.degree, e.field_of_study, e.school || e.school_name].filter(Boolean).join(" "))
      .filter(Boolean);
    if (eduLines.length) parts.push(`Education: ${eduLines.join(" | ")}`);
  }

  if (Array.isArray(profile.certifications) && profile.certifications.length > 0) {
    const certs = profile.certifications.map((c: any) => c.name || c.title).filter(Boolean);
    if (certs.length) parts.push(`Certifications: ${certs.join(", ")}`);
  }

  if (profile.contact_info?.emails?.length) {
    parts.push(`Email: ${profile.contact_info.emails[0]}`);
  }

  return parts.join("\n");
}

function extractSlug(url: string): string | null {
  const match = (url || "").match(/linkedin\.com\/(?:in|pub)\/([^/?\s#]+)/);
  return match ? match[1].replace(/\/+$/, "") : null;
}

async function fetchFullProfile(
  slug: string,
  accounts: Array<{ unipile_account_id: string; account_type: string }>,
  baseUrl: string,
  apiKey: string,
): Promise<{ profileData: Record<string, any> | null; source: string | null }> {
  const priority = ["linkedin_recruiter", "linkedin_sales_nav", "linkedin_classic"];
  const sorted = [...accounts].sort(
    (a, b) => priority.indexOf(a.account_type) - priority.indexOf(b.account_type),
  );

  for (const acct of sorted) {
    try {
      const url = `${baseUrl}/users/${encodeURIComponent(slug)}?account_id=${acct.unipile_account_id}`;
      const res = await fetch(url, {
        headers: { "X-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Object.keys(data).length > 3) {
        return { profileData: data, source: acct.account_type };
      }
    } catch {
      continue;
    }
  }
  return { profileData: null, source: null };
}

// Map externalId to enrichment config
const ENRICH_CONFIGS: Record<string, { limit: number; entity: string; fetchFresh: boolean }> = {
  "enrich-linkedin-candidates": { limit: 20, entity: "candidates", fetchFresh: false },
  "enrich-linkedin-contacts": { limit: 20, entity: "contacts", fetchFresh: false },
  "enrich-linkedin-fresh": { limit: 10, entity: "both", fetchFresh: true },
};

export const enrichLinkedin = schedules.task({
  id: "enrich-linkedin",
  maxDuration: 300,
  run: async (payload) => {
    const config = ENRICH_CONFIGS[payload.externalId ?? ""] ?? ENRICH_CONFIGS["enrich-linkedin-candidates"];
    const limit = config.limit;
    const entity = config.entity;
    const fetchFresh = config.fetchFresh;

    const supabase = getSupabaseAdmin();
    const voyageKey = await getAppSetting("VOYAGE_API_KEY");
    const unipileApiKey = await getAppSetting("UNIPILE_API_KEY");
    const baseUrl = await getUnipileBaseUrl();

    // Get active LinkedIn accounts
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, account_type, account_label")
      .eq("provider", "linkedin")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    const linkedinAccounts = accounts ?? [];
    logger.info("LinkedIn accounts", {
      types: linkedinAccounts.map((a: any) => a.account_type),
      entity,
      fetchFresh,
    });

    let candEmbedded = 0, candSkipped = 0, candFailed = 0;
    let contEmbedded = 0, contSkipped = 0, contFailed = 0;

    // ── Candidates ──────────────────────────────────────────────────
    if (entity === "candidates" || entity === "both") {
      const alreadyEmbedded = await supabase
        .from("resume_embeddings")
        .select("candidate_id")
        .eq("embed_type", "linkedin_profile");

      const embeddedIds = new Set((alreadyEmbedded.data ?? []).map((r: any) => r.candidate_id));

      const { data: candidates } = await supabase
        .from("candidates")
        .select("id, full_name, linkedin_url, linkedin_profile_data, current_title, current_company, location_text")
        .not("linkedin_profile_data", "is", null)
        .neq("linkedin_profile_data", "")
        .limit(limit * 3);

      const toProcess = (candidates ?? []).filter((c: any) => !embeddedIds.has(c.id)).slice(0, limit);

      for (const c of toProcess) {
        try {
          let profileData: Record<string, any> = JSON.parse(c.linkedin_profile_data);
          let enrichmentSource = "stored";

          if (fetchFresh && linkedinAccounts.length > 0 && c.linkedin_url) {
            const slug = extractSlug(c.linkedin_url);
            if (slug) {
              const { profileData: fresh, source } = await fetchFullProfile(
                slug, linkedinAccounts, baseUrl, unipileApiKey,
              );
              if (fresh) {
                profileData = fresh;
                enrichmentSource = source ?? "unipile";
              }
              await delay(500);
            }
          }

          const text = buildLinkedInText(profileData, c.full_name);
          if (text.trim().length < 20) { candSkipped++; continue; }

          const embedding = await getEmbedding(text, voyageKey);

          await supabase
            .from("resume_embeddings")
            .delete()
            .eq("candidate_id", c.id)
            .eq("embed_type", "linkedin_profile");

          await supabase.from("resume_embeddings").insert({
            candidate_id: c.id,
            embedding: JSON.stringify(embedding),
            source_text: text.slice(0, 2000),
            chunk_text: text.slice(0, 2000),
            chunk_index: 0,
            embed_type: "linkedin_profile",
            embed_model: VOYAGE_MODEL,
          });

          await supabase
            .from("candidates")
            .update({
              linkedin_enriched_at: new Date().toISOString(),
              linkedin_enrichment_source: enrichmentSource,
              ...(!c.current_title && profileData.headline
                ? { current_title: profileData.headline }
                : {}),
              ...(!c.location_text && profileData.location
                ? { location_text: profileData.location }
                : {}),
            })
            .eq("id", c.id);

          candEmbedded++;
        } catch (err: any) {
          candFailed++;
          logger.error(`Candidate ${c.id} enrichment error`, { error: err.message });
        }
        await delay(300);
      }
    }

    // ── Contacts ─────────────────────────────────────────────────────
    if (entity === "contacts" || entity === "both") {
      const alreadyEmbedded = await supabase.from("contact_embeddings").select("contact_id");
      const embeddedIds = new Set((alreadyEmbedded.data ?? []).map((r: any) => r.contact_id));

      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, full_name, linkedin_url, linkedin_profile_data, title, company_name, linkedin_current_title, linkedin_current_company, linkedin_headline, linkedin_location")
        .not("linkedin_profile_data", "is", null)
        .neq("linkedin_profile_data", "")
        .limit(limit * 3);

      const toProcess = (contacts ?? []).filter((c: any) => !embeddedIds.has(c.id)).slice(0, limit);

      for (const c of toProcess) {
        try {
          let profileData: Record<string, any> = JSON.parse(c.linkedin_profile_data);
          let enrichmentSource = "stored";

          if (fetchFresh && linkedinAccounts.length > 0 && c.linkedin_url) {
            const slug = extractSlug(c.linkedin_url);
            if (slug) {
              const { profileData: fresh, source } = await fetchFullProfile(
                slug, linkedinAccounts, baseUrl, unipileApiKey,
              );
              if (fresh) {
                profileData = fresh;
                enrichmentSource = source ?? "unipile";
              }
              await delay(500);
            }
          }

          const augmented = {
            ...profileData,
            headline: profileData.headline || c.linkedin_headline || c.title,
            location: profileData.location || c.linkedin_location,
          };
          const text = buildLinkedInText(augmented, c.full_name);
          if (text.trim().length < 20) { contSkipped++; continue; }

          const embedding = await getEmbedding(text, voyageKey);

          await supabase.from("contact_embeddings").delete().eq("contact_id", c.id);
          await supabase.from("contact_embeddings").insert({
            contact_id: c.id,
            embedding: JSON.stringify(embedding),
            source_text: text.slice(0, 2000),
            embed_type: "linkedin_profile",
            embed_model: VOYAGE_MODEL,
          });

          await supabase
            .from("contacts")
            .update({
              linkedin_enriched_at: new Date().toISOString(),
              linkedin_enrichment_source: enrichmentSource,
            })
            .eq("id", c.id);

          contEmbedded++;
        } catch (err: any) {
          contFailed++;
          logger.error(`Contact ${c.id} enrichment error`, { error: err.message });
        }
        await delay(300);
      }
    }

    logger.info("Enrichment complete", {
      candidates: { embedded: candEmbedded, skipped: candSkipped, failed: candFailed },
      contacts: { embedded: contEmbedded, skipped: contSkipped, failed: contFailed },
    });

    return {
      candidates: { embedded: candEmbedded, skipped: candSkipped, failed: candFailed },
      contacts: { embedded: contEmbedded, skipped: contSkipped, failed: contFailed },
    };
  },
});
