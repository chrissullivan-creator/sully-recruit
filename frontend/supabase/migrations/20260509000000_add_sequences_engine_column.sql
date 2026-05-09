-- ============================================================================
-- sequences.engine — picks which scheduler runs an active sequence
-- ============================================================================
-- Phase 1 of the Trigger.dev → Inngest cutover. Every sequence stays on
-- 'trigger' until the bulk-migrate run flips it to 'inngest'. The
-- Trigger.dev sweep filters on this column so the two engines never
-- double-fire the same step_log.
-- ============================================================================

ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'trigger'
    CHECK (engine IN ('trigger', 'inngest'));

CREATE INDEX IF NOT EXISTS idx_sequences_engine_status
  ON public.sequences(engine, status);
