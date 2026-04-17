-- Codex review on PR #65 caught that the prior migration created a *partial*
-- unique index on ai_call_notes(external_call_id) WHERE external_call_id IS NOT NULL.
-- Postgres cannot use a partial index as the ON CONFLICT arbiter unless the
-- same predicate is included in the conflict target. Supabase's PostgREST
-- upsert uses bare ON CONFLICT (external_call_id), so the prior index would
-- have caused upserts to fail with "no unique or exclusion constraint matching
-- the ON CONFLICT specification" — making the original fix ineffective.
--
-- Fix: drop the partial index and replace with a plain unique index. NULLs
-- in unique indexes are treated as distinct in Postgres, so duplicate NULL
-- external_call_id rows are still allowed.

DROP INDEX IF EXISTS public.ai_call_notes_external_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS ai_call_notes_external_call_id_key
  ON public.ai_call_notes(external_call_id);

-- Add the FK on owner_id to match call_logs / candidates (VADE suggestion).
-- Guarded so the migration is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_call_notes_owner_id_fkey'
      AND conrelid = 'public.ai_call_notes'::regclass
  ) THEN
    ALTER TABLE public.ai_call_notes
      ADD CONSTRAINT ai_call_notes_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;
