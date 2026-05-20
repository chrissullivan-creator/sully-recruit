-- Bump-able marker so the re-extraction sweeper knows which rows it
-- has already re-processed with the current prompt. Lets us roll out
-- prompt changes (e.g. #262 expanded the field set) and retroactively
-- backfill candidate fields from old transcripts without re-running
-- Deepgram. Bump the value the sweeper writes when the prompt
-- changes again.

ALTER TABLE ai_call_notes
  ADD COLUMN IF NOT EXISTS reextraction_version integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ai_call_notes_reextraction_pending
  ON ai_call_notes (reextraction_version, created_at)
  WHERE transcript IS NOT NULL;
