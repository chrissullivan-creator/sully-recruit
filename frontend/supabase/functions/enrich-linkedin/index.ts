import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") || "https://api19.unipile.com:14926";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") || "";
const VOYAGE_MODEL = "voyage-finance-2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Voyage embedding ────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

// ─── Build rich text from Unipile profile JSON ───────────────────────────────
// Works with both classic (basic) and recruiter (full) profile shapes.
// The more fields present, the richer the embedding.

function buildLinkedInText(profile: Record<string, any>, entityName?: string): string {
  const parts: string[] = [];

  const name = entityName || [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  if (name) parts.push(`Name: ${name}`);
  if (profile.headline) parts.push(`Headline: ${profile.headline}`);
  if (profile.location) parts.push(`Location: ${profile.location}`);
  if (profile.summary || profile.about) parts.push(`About: ${profile.summary || profile.about}`);

  // Current position (classic sometimes returns this)
  if (profile.current_position) parts.push(`Current Role: ${profile.current_position}`);

  // Skills (recruiter endpoint)
  if (Array.isArray(profile.skills) && profile.skills.length > 0) {
    const skillNames = profile.skills
      .map((s: any) => (typeof s === "string" ? s : s.name || s.skill_name || ""))
      .filter(Boolean);
    if (skillNames.length) parts.push(`Skills: ${skillNames.join(", ")}`);
  }

  // Experience (recruiter endpoint)
  if (Array.isArray(profile.experience) && profile.experience.length > 0) {
    const expLines = profile.experience.map((e: any) => {
      const parts2: string[] = [];
      if (e.title) parts2.push(e.title);
      if (e.company || e.company_name) parts2.push(`at ${e.company || e.company_name}`);
      if (e.start_date || e.date_range) parts2.push(`(${e.date_range || e.start_date})`);
      if (e.description) parts2.push(`- ${String(e.description).slice(0, 300)}`);
      return parts2.join(" ");
    }).filter(Boolean);
    if (expLines.length) parts.push(`Experience:\n${expLines.join("\n")}`);
  }

  // Education (recruiter endpoint)
  if (Array.isArray(profile.education) && profile.education.length > 0) {
    const eduLines = profile.education.map((e: any) => {
      return [e.degree, e.field_of_study, e.school || e.school_name]
        .filter(Boolean).join(" ");
    }).filter(Boolean);
    if (eduLines.length) parts.push(`Education: ${eduLines.join(" | ")}`);
  }

  // Certifications (recruiter endpoint)
  if (Array.isArray(profile.certifications) && profile.certifications.length > 0) {
    const certs = profile.certifications.map((c: any) => c.name || c.title).filter(Boolean);
    if (certs.length) parts.push(`Certifications: ${certs.join(", ")}`);
  }

  // Contact info email (classic)
  if (profile.contact_info?.emails?.length) {
    parts.push(`Email: ${profile.contact_info.emails[0]}`);
  }

  return parts.join("\n");
}

// ─── Unipile: fetch full profile for a slug using best available account ─────
// Recruiter/Sales Nav accounts return richer data than classic.
// We try recruiter accounts first, fall back to classic.

async function fetchFullProfile(
  slug: string,
  accounts: Array<{ unipile_account_id: string; account_type: string }>
): Promise<{ profileData: Record<string, any> | null; source: string | null }> {
  // Sort: recruiter > sales_nav > classic
  const priority = ["linkedin_recruiter", "linkedin_sales_nav", "linkedin_classic"];
  const sorted = [...accounts].sort((a, b) =>
    priority.indexOf(a.account_type) - priority.indexOf(b.account_type)
  );

  for (const acct of sorted) {
    try {
      const url = `${UNIPILE_API_URL}/api/v1/users/${encodeURIComponent(slug)}?account_id=${acct.unipile_account_id}`;
      const res = await fetch(url, {
        headers: { "X-API-KEY": UNIPILE_API_KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Object.keys(data).length > 3) {
        return { profileData: data, source: acct.account_type };
      }
    } catch { continue; }
  }
  return { profileData: null, source: null };
}

function extractSlug(url: string): string | null {
  const match = (url || "").match(/linkedin\.com\/(?:in|pub)\/([^/?\s#]+)/);
  return match ? match[1].replace(/\/+$/, "") : null;
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(body.limit ?? 20, 20);
    const dry_run = body.dry_run ?? false;
    const entity = body.entity ?? "candidates"; // 'candidates' | 'contacts' | 'both'
    const fetch_fresh = body.fetch_fresh ?? false; // hit Unipile for fresher/richer data

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Get active LinkedIn accounts (sorted by capability)
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, account_type, account_label")
      .eq("provider", "linkedin")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    const linkedinAccounts = accounts ?? [];
    const hasRecruiter = linkedinAccounts.some((a: any) =>
      ["linkedin_recruiter", "linkedin_sales_nav"].includes(a.account_type)
    );

    console.log(`[enrich-linkedin] accounts: ${linkedinAccounts.map((a: any) => a.account_type).join(", ")} | hasRecruiter: ${hasRecruiter}`);

    let cand_embedded = 0, cand_skipped = 0, cand_failed = 0;
    let cont_embedded = 0, cont_skipped = 0, cont_failed = 0;

    // ── Candidates ──────────────────────────────────────────────────────────
    if (entity === "candidates" || entity === "both") {
      // Find candidates with linkedin_profile_data not yet embedded as linkedin_profile type
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

      if (dry_run) {
        return respond({
          dry_run: true,
          candidates_to_embed: toProcess.length,
          has_recruiter_account: hasRecruiter,
          sample: toProcess.slice(0, 5).map((c: any) => c.full_name),
        });
      }

      for (const c of toProcess) {
        try {
          let profileData: Record<string, any> = JSON.parse(c.linkedin_profile_data);
          let enrichmentSource = "stored";

          // Optionally fetch fresh/richer profile from Unipile
          if (fetch_fresh && linkedinAccounts.length > 0 && c.linkedin_url) {
            const slug = extractSlug(c.linkedin_url);
            if (slug) {
              const { profileData: fresh, source } = await fetchFullProfile(slug, linkedinAccounts);
              if (fresh) { profileData = fresh; enrichmentSource = source ?? "unipile"; }
              await sleep(500); // be polite to Unipile
            }
          }

          const text = buildLinkedInText(profileData, c.full_name);
          if (text.trim().length < 20) { cand_skipped++; continue; }

          const embedding = await getEmbedding(text);

          // Upsert — delete old linkedin_profile embedding first
          await supabase.from("resume_embeddings").delete()
            .eq("candidate_id", c.id).eq("embed_type", "linkedin_profile");

          await supabase.from("resume_embeddings").insert({
            candidate_id: c.id,
            embedding: JSON.stringify(embedding),
            source_text: text.slice(0, 2000),
            chunk_text: text.slice(0, 2000),
            chunk_index: 0,
            embed_type: "linkedin_profile",
            embed_model: VOYAGE_MODEL,
          });

          // Update enrichment metadata
          await supabase.from("candidates").update({
            linkedin_enriched_at: new Date().toISOString(),
            linkedin_enrichment_source: enrichmentSource,
            // Backfill blanks from profile
            ...(!c.current_title && profileData.headline ? { current_title: profileData.headline } : {}),
            ...(!c.location_text && profileData.location ? { location_text: profileData.location } : {}),
          }).eq("id", c.id);

          cand_embedded++;
        } catch (err: any) {
          cand_failed++;
          console.error(`[enrich-linkedin] candidate ${c.id}:`, err?.message);
        }

        await sleep(300); // ~3 Voyage calls/sec, well within limits
      }
    }

    // ── Contacts ─────────────────────────────────────────────────────────────
    if (entity === "contacts" || entity === "both") {
      const alreadyEmbedded = await supabase
        .from("contact_embeddings")
        .select("contact_id");

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

          if (fetch_fresh && linkedinAccounts.length > 0 && c.linkedin_url) {
            const slug = extractSlug(c.linkedin_url);
            if (slug) {
              const { profileData: fresh, source } = await fetchFullProfile(slug, linkedinAccounts);
              if (fresh) { profileData = fresh; enrichmentSource = source ?? "unipile"; }
              await sleep(500);
            }
          }

          // Build text — contacts also have dedicated linkedin fields
          const augmented = {
            ...profileData,
            headline: profileData.headline || c.linkedin_headline || c.title,
            location: profileData.location || c.linkedin_location,
          };
          const text = buildLinkedInText(augmented, c.full_name);
          if (text.trim().length < 20) { cont_skipped++; continue; }

          const embedding = await getEmbedding(text);

          await supabase.from("contact_embeddings").delete().eq("contact_id", c.id);
          await supabase.from("contact_embeddings").insert({
            contact_id: c.id,
            embedding: JSON.stringify(embedding),
            source_text: text.slice(0, 2000),
            embed_type: "linkedin_profile",
            embed_model: VOYAGE_MODEL,
          });

          await supabase.from("contacts").update({
            linkedin_enriched_at: new Date().toISOString(),
            linkedin_enrichment_source: enrichmentSource,
          }).eq("id", c.id);

          cont_embedded++;
        } catch (err: any) {
          cont_failed++;
          console.error(`[enrich-linkedin] contact ${c.id}:`, err?.message);
        }

        await sleep(300);
      }
    }

    return respond({
      success: true,
      has_recruiter_account: hasRecruiter,
      candidates: { embedded: cand_embedded, skipped: cand_skipped, failed: cand_failed },
      contacts: { embedded: cont_embedded, skipped: cont_skipped, failed: cont_failed },
    });

  } catch (err: any) {
    console.error("[enrich-linkedin] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
