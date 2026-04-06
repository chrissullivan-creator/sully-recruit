-- Disable the legacy process-sequence-emails pg_cron job.
-- This edge function has been replaced by Trigger.dev tasks:
--   sequence-sweep (scheduled) + sequence-step (per-enrollment)
SELECT cron.unschedule('process-sequence-emails');
