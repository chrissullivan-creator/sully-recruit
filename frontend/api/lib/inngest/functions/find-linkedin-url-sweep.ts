import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";

/**
 * Every-15-min cron that picks people without a LinkedIn URL and fans
 * out `people/find-linkedin-url.requested` events for each. The actual
 * Unipile search runs in `find-linkedin-url-by-name`, which has a
 * global concurrency cap of 5 so this cron can queue aggressively
 * without overwhelming the API.
 *
 * Pairs with the BEFORE trigger that auto-flips
 * `unipile_resolve_status='pending'` once a URL is written — so a hit
 * from the search chains straight into the resolve cron, then into
 * fetch-entity-history.
 *
 * Query mirrors `idx_people_linkedin_search_pending`:
 *   - no linkedin_url
 *   - linkedin_search_status NULL or 'pending'
 *   - is_stub IS NOT TRUE
 *   - has a name (full_name OR first_name+last_name)
 *
 * Orders by `linkedin_search_attempted_at NULLS FIRST` so never-tried
 * people get queued before retries.
 */

const BATCH = 250;

export const findLinkedinUrlSweep = inngest.createFunction(
  { id: "find-linkedin-url-sweep", name: "Find LinkedIn URL sweep (Inngest)" },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const { data: people, error } = await supabase
      .from("people")
      .select("id, full_name, first_name, last_name")
      .or("linkedin_url.is.null,linkedin_url.eq.")
      .or("linkedin_search_status.is.null,linkedin_search_status.eq.pending")
      .neq("is_stub", true)
      .order("linkedin_search_attempted_at", { ascending: true, nullsFirst: true })
      .limit(BATCH);

    if (error) {
      logger.error("find-linkedin-url-sweep query failed", { error: error.message });
      return { error: error.message };
    }

    if (!people?.length) {
      logger.info("No people need LinkedIn URL search");
      return { dispatched: 0 };
    }

    // Filter out rows with no name client-side — the OR-of-name in a
    // PostgREST filter is awkward and the row count's small enough.
    const eligible = people.filter((p: any) => {
      const full = (p.full_name || "").trim();
      const fl = `${(p.first_name || "").trim()} ${(p.last_name || "").trim()}`.trim();
      return !!full || !!fl;
    });

    if (eligible.length === 0) {
      logger.info("Batch had no name-bearing rows");
      return { dispatched: 0, scanned: people.length };
    }

    const events = eligible.map((p: any) => ({
      // Hour-bucketed id so retry waves don't collide with the
      // per-person concurrency cap inside find-linkedin-url-by-name.
      id: `find-linkedin-${p.id}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "people/find-linkedin-url.requested" as const,
      data: { person_id: p.id },
    }));

    let dispatched = 0;
    const chunkSize = 500;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      try {
        await inngest.send(chunk);
        dispatched += chunk.length;
      } catch (err: any) {
        logger.warn("Dispatch chunk failed", {
          chunkSize: chunk.length,
          error: err.message,
        });
      }
    }

    logger.info("LinkedIn URL search dispatched", {
      dispatched,
      scanned: people.length,
      sample_ids: eligible.slice(0, 5).map((p: any) => p.id),
    });
    return { dispatched, scanned: people.length, batch_size: BATCH };
  },
);
