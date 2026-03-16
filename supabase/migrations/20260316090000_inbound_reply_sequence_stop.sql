-- Track why/where a sequence was stopped by inbound reply
ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS stopped_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_channel text,
  ADD COLUMN IF NOT EXISTS stop_message_id uuid,
  ADD COLUMN IF NOT EXISTS stop_context jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sequence_enrollments_stop_message_id_fkey'
  ) THEN
    ALTER TABLE public.sequence_enrollments
      ADD CONSTRAINT sequence_enrollments_stop_message_id_fkey
      FOREIGN KEY (stop_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_active_candidate
  ON public.sequence_enrollments(candidate_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_active_contact
  ON public.sequence_enrollments(contact_id)
  WHERE status = 'active';
