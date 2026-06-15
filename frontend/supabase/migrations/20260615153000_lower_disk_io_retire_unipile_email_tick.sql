-- Lower Supabase Disk IO budget consumption.
--
-- Investigation (pg_stat_statements / cron.job / table sizing) found the project
-- was burning its Disk IO burst budget on two things:
--
--   1. A pg_cron job `unipile-email-tick` (every 5 min) that called the
--      `public.unipile_email_tick()` SQL function. It was the #1 IO consumer by
--      ~20x (9.2M shared blocks read), because each tick read email-list response
--      bodies back out of the pg_net response store. It was created ad-hoc (never
--      in the repo) and is functionally DUPLICATED by the Inngest `backfill-emails`
--      job (frontend/api/lib/inngest/functions/backfill-emails.ts — every 5 min,
--      3-day window, kill-switch aware), which is strictly more complete. Retired.
--
--   2. `net._http_response` had bloated to ~1.37 GB (1.3 GB of cold toast) and had
--      never been autovacuumed, so every tick's response lookups were cold disk
--      reads. Reclaimed to ~9 MB.
--
-- The `unipile_email_tick()` function and `unipile_pull_state` table are LEFT IN
-- PLACE (just unscheduled) so the poll can be re-enabled if ever needed:
--   SELECT cron.schedule('unipile-email-tick', '*/5 * * * *',
--                        'SELECT public.unipile_email_tick()');
--
-- One-time maintenance that CANNOT live in a transactional migration was run
-- manually via MCP at deploy time (recorded here for the audit trail):
--   DELETE FROM net._http_response WHERE created < now() - interval '1 hour';
--   VACUUM (FULL, ANALYZE) net._http_response;   -- 1.37 GB -> ~9 MB
-- Note: `ALTER DATABASE postgres SET pg_net.ttl = '1 hour'` is rejected by Supabase
-- ("parameter cannot be changed now"); pg_net retention stays at its 6h default,
-- which is fine now that the high-frequency reader (the tick) is gone.

-- 1. Retire the redundant email-poll cron (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'unipile-email-tick') THEN
    PERFORM cron.unschedule('unipile-email-tick');
  END IF;
END $$;

-- 2. Drop a redundant index on messages.external_message_id.
--    `idx_messages_unipile_external_message_id` is UNIQUE (external_message_id)
--    WHERE provider='unipile' AND channel_type='linkedin'. Its uniqueness is fully
--    subsumed by `uq_messages_provider_external_id` UNIQUE (provider,
--    external_message_id), and equality lookups on external_message_id are served
--    by `idx_messages_external_message_id`. No code uses ON CONFLICT against it.
--    NOTE: the plain `idx_messages_external_message_id` is intentionally KEPT — it
--    is the only index with external_message_id as the leading column, so it serves
--    the dedup existence checks (WHERE external_message_id = ?) that every email
--    backfill runs. Dropping it would force seq scans and INCREASE IO.
DROP INDEX IF EXISTS public.idx_messages_unipile_external_message_id;
