import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Every-5-minutes companion to `backfill-entity-histories`. The hourly
 * sweep covers stale-refresh + first-time-sync of older rows; this
 * function exists purely to shrink the lag between "candidate added"
 * and "email/LinkedIn history available" from <1h to <5min.
 *
 * Selection:
 *   - last_history_synced_at IS NULL (never synced)
 *   - created_at > NOW() - 1h            (only recent rows — avoids
 *                                          double-pulling stragglers
 *                                          the hourly cron is already
 *                                          working through)
 *   - has at least one contact channel
 *   - not a stub (resume still parsing)
 *
 * Batch is small (20) because the per-person Inngest function runs
 * with 250ms throttle between Unipile calls — a too-large fan would
 * starve other crons. fetch-entity-history's per-entity concurrency
 * key prevents overlapping fans for the same person.
 */
const BATCH = 20;

export const quickBackfillNewPeople = inngest.createFunction(
  { id: "quick-backfill-new-people", name: "Quick backfill new-people (Inngest)" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { data: people, error } = await supabase
      .from("people")
      .select("id, type")
      .is("last_history_synced_at", null)
      .gt("created_at", cutoff)
      .neq("is_stub", true)
      .or("primary_email.not.is.null,work_email.not.is.null,personal_email.not.is.null,linkedin_url.not.is.null")
      .order("created_at", { ascending: false })
      .limit(BATCH);

    if (error) {
      logger.error("Quick-backfill query failed", { error: error.message });
      return { error: error.message };
    }
    if (!people?.length) return { dispatched: 0 };

    // Stamp distinct id per 5-min bucket so re-fires across consecutive
    // runs dedup. The per-entity concurrency cap in fetch-entity-history
    // serializes any cross-window overlap.
    const stamp = Math.floor(Date.now() / 300_000);
    const events = people.map((p: any) => ({
      id: `quick-backfill-${p.id}-${stamp}`,
      name: "messages/fetch-entity-history.requested" as const,
      data: {
        entity_id: p.id,
        entity_type: (p.type === "client" ? "contact" : "candidate") as "candidate" | "contact",
      },
    }));

    await inngest.send(events);
    logger.info("Quick-backfill dispatched", {
      dispatched: events.length,
      sample_ids: people.slice(0, 5).map((p: any) => p.id),
    });
    return { dispatched: events.length };
  },
);
