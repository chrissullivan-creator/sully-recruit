-- Phase 4.5: snooze wake + follow-up reminder tracking columns.
--
-- woke_from_snooze_at: set by the wake-snoozed-threads cron when a
-- thread's snoozed_until passes. Used by the UI to show a brief
-- "just woke from snooze" banner on the thread.
--
-- follow_up_at_set_at: marks WHEN the user set the follow-up reminder.
-- Used to detect "no reply since the reminder was set" — distinct from
-- the existing inbound timestamps which only tell us the last reply.
--
-- follow_up_triggered_at: marks when the cron fired the reminder, so
-- we don't fire it twice for the same window.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS woke_from_snooze_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_at_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_triggered_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversations_woke_from_snooze_at
  ON public.conversations(woke_from_snooze_at DESC)
  WHERE woke_from_snooze_at IS NOT NULL;
