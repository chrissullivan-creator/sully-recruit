-- Bring ai_call_notes schema in line with process-call-deepgram.ts upsert.
-- Prior migration created a minimal table; the task writes ~20 more columns
-- and upserts on external_call_id, which needs a unique index.

ALTER TABLE public.ai_call_notes
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS call_direction TEXT,
  ADD COLUMN IF NOT EXISTS call_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS call_duration_formatted TEXT,
  ADD COLUMN IF NOT EXISTS transcription_provider TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_action_items TEXT,
  ADD COLUMN IF NOT EXISTS extracted_reason_for_leaving TEXT,
  ADD COLUMN IF NOT EXISTS extracted_current_base TEXT,
  ADD COLUMN IF NOT EXISTS extracted_current_bonus TEXT,
  ADD COLUMN IF NOT EXISTS extracted_target_base TEXT,
  ADD COLUMN IF NOT EXISTS extracted_target_bonus TEXT,
  ADD COLUMN IF NOT EXISTS extracted_notes TEXT,
  ADD COLUMN IF NOT EXISTS recording_url TEXT,
  ADD COLUMN IF NOT EXISTS processing_status TEXT,
  ADD COLUMN IF NOT EXISTS external_call_id TEXT,
  ADD COLUMN IF NOT EXISTS owner_id UUID,
  ADD COLUMN IF NOT EXISTS call_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS call_ended_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ai_call_notes_external_call_id_key
  ON public.ai_call_notes(external_call_id)
  WHERE external_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_call_notes_phone_number
  ON public.ai_call_notes(phone_number);

CREATE INDEX IF NOT EXISTS idx_ai_call_notes_call_log_id
  ON public.ai_call_notes(call_log_id);
