import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";

/**
 * Hourly cron that picks companies missing Apollo enrichment and fans
 * out `companies/enrich-via-apollo.requested` events. Pairs with
 * `enrich-company-via-apollo` which does the API call + write.
 *
 * Query: any non-deleted company with a domain (Apollo enrichment needs
 * one to be useful) whose `apollo_company_status` is NULL or 'pending'.
 * Orders by `apollo_company_enriched_at NULLS FIRST` so never-tried
 * companies get picked before retries.
 */

const BATCH = 200;

export const enrichCompaniesSweep = inngest.createFunction(
  { id: "enrich-companies-sweep", name: "Enrich companies via Apollo sweep (Inngest)" },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const { data: companies, error } = await supabase
      .from("companies")
      .select("id, name, domain")
      .or("apollo_company_status.is.null,apollo_company_status.eq.pending")
      .is("deleted_at", null)
      .not("domain", "is", null)
      .neq("domain", "")
      .order("apollo_company_enriched_at", { ascending: true, nullsFirst: true })
      .limit(BATCH);

    if (error) {
      logger.error("enrich-companies-sweep query failed", { error: error.message });
      return { error: error.message };
    }

    if (!companies?.length) {
      logger.info("No companies need Apollo enrichment");
      return { dispatched: 0 };
    }

    const events = companies.map((c: any) => ({
      // Hour-bucketed id so retry waves don't collide with per-company
      // concurrency cap.
      id: `enrich-company-${c.id}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "companies/enrich-via-apollo.requested" as const,
      data: { company_id: c.id },
    }));

    let dispatched = 0;
    const chunkSize = 500;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      try {
        await inngest.send(chunk);
        dispatched += chunk.length;
      } catch (err: any) {
        logger.warn("Dispatch chunk failed", { chunkSize: chunk.length, error: err.message });
      }
    }

    logger.info("Company enrichment dispatched", {
      dispatched,
      sample_ids: companies.slice(0, 5).map((c: any) => c.id),
    });
    return { dispatched, batch_size: BATCH };
  },
);
