-- Unified inbound reply handling foundation

-- 1) sequence_enrollments stop metadata
ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS stopped_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_reason text,
  ADD COLUMN IF NOT EXISTS stopped_by_channel text,
  ADD COLUMN IF NOT EXISTS stopped_by_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL;

-- 2) messages: provider-agnostic inbound/outbound shape
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS candidate_id uuid REFERENCES public.candidates(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS external_message_id text,
  ADD COLUMN IF NOT EXISTS external_thread_id text,
  ADD COLUMN IF NOT EXISTS from_identity text,
  ADD COLUMN IF NOT EXISTS to_identity text,
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Ensure direction exists and is normalized
ALTER TABLE public.messages
  ALTER COLUMN direction TYPE text USING direction::text;

-- sent_at already exists in legacy schema; keep as source of truth for message timestamp

-- Backfill legacy columns when present
UPDATE public.messages
SET body = COALESCE(body, content)
WHERE body IS NULL
  AND content IS NOT NULL;

UPDATE public.messages
SET external_message_id = COALESCE(external_message_id, external_id)
WHERE external_message_id IS NULL
  AND external_id IS NOT NULL;


-- 3) Provider + channel validation
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_provider_check,
  DROP CONSTRAINT IF EXISTS messages_channel_check,
  DROP CONSTRAINT IF EXISTS messages_direction_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_provider_check
  CHECK (provider IS NULL OR provider IN ('microsoft', 'ringcentral', 'unipile')),
  ADD CONSTRAINT messages_channel_check
  CHECK (channel IS NULL OR channel IN ('email', 'sms', 'linkedin_inmail', 'linkedin_message')),
  ADD CONSTRAINT messages_direction_check
  CHECK (direction IN ('inbound', 'outbound'));

-- Keep legacy not-null requirement satisfied by body
ALTER TABLE public.messages
  ALTER COLUMN body SET NOT NULL;

-- 5) Indexes + inbound dedupe guard
CREATE INDEX IF NOT EXISTS idx_messages_candidate_contact_sent_at
  ON public.messages (candidate_id, contact_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_channel_direction_sent_at
  ON public.messages (channel, direction, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_external_thread
  ON public.messages (provider, external_thread_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inbound_provider_external_message_unique
  ON public.messages (provider, external_message_id)
  WHERE direction = 'inbound' AND external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_active_person
  ON public.sequence_enrollments (candidate_id, contact_id)
  WHERE status = 'active';

-- 6) stop function used by inbound reply handler
CREATE OR REPLACE FUNCTION public.stop_active_sequences_for_person(
  p_candidate_id uuid,
  p_contact_id uuid,
  p_channel text,
  p_message_id uuid,
  p_reason text DEFAULT 'inbound_reply'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_count integer;
BEGIN
  UPDATE public.sequence_enrollments
  SET status = 'replied',
      stopped_at = now(),
      stop_reason = p_reason,
      stopped_by_channel = p_channel,
      stopped_by_message_id = p_message_id,
      updated_at = now()
  WHERE status = 'active'
    AND (
      (p_candidate_id IS NOT NULL AND candidate_id = p_candidate_id)
      OR (p_contact_id IS NOT NULL AND contact_id = p_contact_id)
    );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN COALESCE(v_updated_count, 0);
END;
$$;
