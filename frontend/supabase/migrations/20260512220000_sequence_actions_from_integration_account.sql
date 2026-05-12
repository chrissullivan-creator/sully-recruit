-- Per-step sender selection for sequences.
--
-- Stage 1 of the shared-mailbox / multi-sender work. Adds a nullable
-- FK on sequence_actions pointing at the integration_account to send
-- from. When null, sendEmail falls back to the enrollment owner's
-- profiles.email — preserves all legacy single-mailbox behaviour.
--
-- Stage 2 (separate PR) adds the sender dropdown to the sequence
-- builder UI that writes this column.

ALTER TABLE public.sequence_actions
  ADD COLUMN IF NOT EXISTS from_integration_account_id uuid NULL
    REFERENCES public.integration_accounts(id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.sequence_actions.from_integration_account_id IS
  'Optional override for the send-from email. When set, sendEmail uses '
  'this row''s email_address (shared mailbox, secondary inbox, etc.) '
  'instead of the enrollment owner''s profiles.email. Null = default.';

-- No backfill — legacy rows stay null, behaviour unchanged for them.
