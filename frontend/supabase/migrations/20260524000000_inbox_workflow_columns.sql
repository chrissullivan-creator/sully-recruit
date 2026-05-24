-- Phase 4: Inbox workflow columns.
-- Adds flagged, snoozed_until, follow_up_at, status to conversations
-- so the inbox UI can snooze, flag, set follow-up reminders, and show
-- conversation status pills.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IS NULL OR status IN ('awaiting_reply','replied','snoozed','closed','no_reply_needed'));

CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_until
  ON public.conversations(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_flagged
  ON public.conversations(flagged)
  WHERE flagged = true;

CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON public.conversations(status)
  WHERE status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_follow_up_at
  ON public.conversations(follow_up_at)
  WHERE follow_up_at IS NOT NULL;
