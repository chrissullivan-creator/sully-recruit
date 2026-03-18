
ALTER TABLE public.sequence_steps
  ADD COLUMN IF NOT EXISTS account_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_signature boolean NOT NULL DEFAULT false;
