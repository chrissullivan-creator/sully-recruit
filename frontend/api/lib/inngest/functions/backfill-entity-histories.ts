import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Hourly cron that picks `BATCH` people whose message history is stale
 * or never been synced, and fans out `messages/fetch-entity-history.requested`
 * events for each.
 *
 * NULL `last_history_synced_at` sorts first (NULLS FIRST in the index +
 * `ORDER BY ... NULLS FIRST`) so newly-added candidates / clients get
 * picked up on the next tick — typical lag is <1 hour from insert to
 * first email/LinkedIn pull.
 *
 * After the first pass, every person gets re-synced when their stamp
 * crosses the `STALE_AFTER` threshold (default 30 days). At ~3,500
 * people / 50/hour / 24h = ~7 days to refresh the whole list once
 * everyone has been seen at least once.
 *
 * Doesn't touch active conversations: the regular `backfill-emails`
 * (every 5m) and `backfill-linkedin-messages` (every 5m) crons still
 * pull recent traffic across all mailboxes. This cron is only for
 * deeper per-person history (the same thing the "Fetch History" UI
 * button does).
 *
 * Concurrency keyed on `entity_id` in fetch-entity-history prevents
 * duplicate fans for the same person from firing in parallel.
 */

const BATCH = 50;
const STALE_AFTER_DAYS = 30;

export const backfillEntityHistories = inngest.createFunction(
  { id: "backfill-entity-histories", name: "Backfill per-entity message history (Inngest)" },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const staleCutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Pick stale-or-never-synced people. Skip stub rows (still pending
    // resume parse) and rows with no contact info to fetch against.
    const { data: people, error } = await supabase
      .from("people")
      .select("id, type, primary_email, work_email, personal_email, linkedin_url, last_history_synced_at")
      .or(`last_history_synced_at.is.null,last_history_synced_at.lt.${staleCutoff}`)
      .neq("is_stub", true)
      .or("primary_email.not.is.null,work_email.not.is.null,personal_email.not.is.null,linkedin_url.not.is.null")
      .order("last_history_synced_at", { ascending: true, nullsFirst: true })
      .limit(BATCH);

    if (error) {
      logger.error("Backfill query failed", { error: error.message });
      return { error: error.message };
    }

    if (!people?.length) {
      logger.info("No people need history sync");
      return { dispatched: 0 };
    }

    const events = people.map((p: any) => ({
      // Distinct id per hour so concurrency-cap conflicts get a clean
      // dedup window. The Inngest function's internal idempotency
      // (concurrency: 1 per entity_id) handles overlapping fans cleanly.
      id: `entity-history-${p.id}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "messages/fetch-entity-history.requested" as const,
      data: {
        entity_id: p.id,
        entity_type: (p.type === "client" ? "contact" : "candidate") as "candidate" | "contact",
      },
    }));

    // inngest.send caps at 5000 events/call — chunked at 500 for safety
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

    logger.info("Entity history backfill dispatched", {
      dispatched,
      sample_ids: people.slice(0, 5).map((p: any) => p.id),
    });
    return { dispatched, batch_size: BATCH, stale_after_days: STALE_AFTER_DAYS };
  },
);
