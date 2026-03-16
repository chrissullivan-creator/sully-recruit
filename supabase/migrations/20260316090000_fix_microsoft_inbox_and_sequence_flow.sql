-- Microsoft inbox connectivity + inbound metadata hardening
ALTER TABLE public.integration_accounts
  ADD COLUMN IF NOT EXISTS auth_provider text,
  ADD COLUMN IF NOT EXISTS access_token text,
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_config jsonb,
  ADD COLUMN IF NOT EXISTS microsoft_user_id text,
  ADD COLUMN IF NOT EXISTS microsoft_subscription_id text,
  ADD COLUMN IF NOT EXISTS microsoft_subscription_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS integration_accounts_owner_provider_external_uidx
  ON public.integration_accounts (owner_user_id, auth_provider, external_account_id)
  WHERE auth_provider IS NOT NULL AND external_account_id IS NOT NULL;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS message_type text,
  ADD COLUMN IF NOT EXISTS channel_type text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS external_message_id text,
  ADD COLUMN IF NOT EXISTS external_conversation_id text,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS sender_name text,
  ADD COLUMN IF NOT EXISTS sender_address text,
  ADD COLUMN IF NOT EXISTS recipient_address text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb,
  ADD COLUMN IF NOT EXISTS integration_account_id uuid REFERENCES public.integration_accounts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_external_message_id_uidx
  ON public.messages (external_message_id)
  WHERE external_message_id IS NOT NULL;
