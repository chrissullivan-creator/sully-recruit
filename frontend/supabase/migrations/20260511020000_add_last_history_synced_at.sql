-- Track when we last fetched per-entity message history (email + LinkedIn)
-- via the `messages/fetch-entity-history.requested` Inngest function.
-- The `backfill-entity-histories` cron picks people with NULL or stale
-- `last_history_synced_at` and fans out fetch events. Newly-added people
-- get picked up on the next cron tick (hourly) since NULL sorts first.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS last_history_synced_at timestamptz;

-- Index on (last_history_synced_at NULLS FIRST) so the cron's "stale or
-- never synced" query is a single index scan rather than a full table sort.
CREATE INDEX IF NOT EXISTS idx_people_last_history_synced_at
  ON people (last_history_synced_at NULLS FIRST);
