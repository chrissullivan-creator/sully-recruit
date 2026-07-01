-- Phase 3 workflow support for Joe's action queue.
-- Adds snooze + lightweight audit history while preserving the existing
-- owner-RLS policy from 20260621030000_joe_action_queue.sql.

ALTER TABLE public.joe_action_queue
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.joe_action_queue
  DROP CONSTRAINT IF EXISTS joe_action_queue_status_check;

ALTER TABLE public.joe_action_queue
  ADD CONSTRAINT joe_action_queue_status_check
  CHECK (status IN ('pending','approved','done','dismissed','snoozed'));

CREATE INDEX IF NOT EXISTS idx_joe_action_queue_snoozed
  ON public.joe_action_queue (owner_user_id, snoozed_until)
  WHERE status = 'snoozed' AND snoozed_until IS NOT NULL;
