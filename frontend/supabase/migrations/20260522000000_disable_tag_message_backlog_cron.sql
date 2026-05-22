-- Disable `tag_message_backlog_15min` pg_cron job.
--
-- The job fired `tag-message` (a claude-sonnet-4-6 edge function with up to
-- 8000-char inputs) at 30 messages/tick × 4 ticks/hr = 120 Sonnet calls/hr
-- against an 8,646-message backlog — roughly $1.60/hr indefinitely. Combined
-- with the reextract-call-intel cron (separately disabled), it was driving the
-- ~$10/hr Claude bleed.
--
-- To re-enable later (after switching the edge function to Haiku, throttling
-- the batch, or rate-limiting from the cron itself), restore via the original
-- definition below.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tag_message_backlog_15min') THEN
    PERFORM cron.unschedule('tag_message_backlog_15min');
  END IF;
END $$;
