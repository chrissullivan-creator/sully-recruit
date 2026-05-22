import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  getApolloConfig,
  apolloEnrichOrganization,
} from "../../integrations/apollo.js";

/**
 * Enrich a single company via Apollo's /organizations/enrich and write
 * the missing fields back. Triggered from:
 *   - enrich-companies-sweep (cron, picks unenriched companies)
 *   - On-demand callers (UI "Enrich" button, manual triggers)
 *
 * Only writes back to columns that are currently empty — never
 * overwrites operator-curated data. Stamps
 * `apollo_company_enriched_at` so the sweep can skip already-done rows.
 *
 * Concurrency keyed on company_id prevents duplicate enrichments from
 * racing. Global cap throttles Apollo API load when the sweep fans out.
 */
interface EnrichCompanyPayload {
  company_id: string;
}

export const enrichCompanyViaApollo = inngest.createFunction(
  {
    id: "enrich-company-via-apollo",
    name: "Enrich company via Apollo (Inngest)",
    retries: 1,
    concurrency: [
      { key: "event.data.company_id", limit: 1 },
      { limit: 5 },
    ],
  },
  { event: "companies/enrich-via-apollo.requested" },
  async ({ event, logger }) => {
    const { company_id } = event.data as EnrichCompanyPayload;
    const supabase = getSupabaseAdmin();

    const { data: company, error: fetchErr } = await supabase
      .from("companies")
      .select(
        "id, name, domain, website, linkedin_url, description, industry, size, hq_location, logo_url",
      )
      .eq("id", company_id)
      .maybeSingle();
    if (fetchErr || !company) {
      logger.warn("enrich-company: not found", { company_id, error: fetchErr?.message });
      return { skipped: true, reason: "not_found" };
    }

    const apolloConfig = await getApolloConfig(supabase);
    if (!apolloConfig) {
      logger.warn("enrich-company: APOLLO_API_KEY not configured");
      return { skipped: true, reason: "no_apollo_key" };
    }

    const domain = (company.domain || "").trim() || extractDomain(company.website);
    if (!domain && !company.name) {
      await stampAttempted(supabase, company_id, "insufficient_data");
      return { skipped: true, reason: "no_domain_or_name" };
    }

    let org;
    try {
      org = await apolloEnrichOrganization(apolloConfig, {
        domain: domain || undefined,
        organization_name: domain ? undefined : company.name,
      });
    } catch (err: any) {
      logger.warn("enrich-company: apollo threw", { company_id, error: err?.message });
      await stampAttempted(supabase, company_id, "failed");
      return { error: err?.message ?? "apollo_failed" };
    }

    if (!org) {
      await stampAttempted(supabase, company_id, "not_found");
      return { matched: false, reason: "no_match" };
    }

    // Build update, only filling columns that are currently empty so we
    // never overwrite operator-curated data.
    const update: Record<string, any> = {
      apollo_company_enriched_at: new Date().toISOString(),
      apollo_company_status: "enriched",
    };
    if (!company.description && org.description) update.description = org.description;
    if (!company.industry && org.industry) update.industry = org.industry;
    if (!company.size && org.estimated_num_employees) {
      update.size = sizeBucket(org.estimated_num_employees);
    }
    if (!company.linkedin_url && org.linkedin_url) update.linkedin_url = org.linkedin_url;
    if (!company.website && org.website_url) update.website = org.website_url;
    if (!company.logo_url && org.logo_url) update.logo_url = org.logo_url;
    if (!company.domain && org.primary_domain) update.domain = org.primary_domain;
    if (!company.hq_location && (org.city || org.state || org.country)) {
      update.hq_location = [org.city, org.state, org.country].filter(Boolean).join(", ");
    }

    const { error: updateErr } = await supabase
      .from("companies")
      .update(update as any)
      .eq("id", company_id);
    if (updateErr) {
      logger.error("enrich-company: update failed", { company_id, error: updateErr.message });
      return { error: updateErr.message };
    }

    return {
      matched: true,
      company_id,
      fields_written: Object.keys(update).filter((k) => !k.startsWith("apollo_")),
    };
  },
);

async function stampAttempted(
  supabase: any,
  company_id: string,
  status: string,
): Promise<void> {
  await supabase
    .from("companies")
    .update({
      apollo_company_status: status,
      apollo_company_enriched_at: new Date().toISOString(),
    } as any)
    .eq("id", company_id);
}

function extractDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sizeBucket(n: number): string {
  if (n < 11) return "1-10";
  if (n < 51) return "11-50";
  if (n < 201) return "51-200";
  if (n < 501) return "201-500";
  if (n < 1001) return "501-1000";
  if (n < 5001) return "1001-5000";
  if (n < 10001) return "5001-10000";
  return "10001+";
}
