-- Remove legacy prospect compatibility paths from live schema.
-- Active recipient model is candidate/contact only.

-- 1) Drop legacy views/routines if they still exist.
DROP VIEW IF EXISTS public.v_sequence_enrollments;
DROP FUNCTION IF EXISTS public.promote_prospect_to_candidate(uuid);
DROP FUNCTION IF EXISTS public.promote_prospect_to_candidate(text);

-- 2) Remove obsolete prospect columns/FKs if present.
ALTER TABLE IF EXISTS public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_prospect_id_fkey,
  DROP COLUMN IF EXISTS prospect_id;

ALTER TABLE IF EXISTS public.candidates
  DROP CONSTRAINT IF EXISTS candidates_prospect_id_fkey,
  DROP COLUMN IF EXISTS prospect_id;

-- 3) Normalize recipient check to active schema.
ALTER TABLE IF EXISTS public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_recipient_xor_check;

ALTER TABLE IF EXISTS public.sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_recipient_xor_check
  CHECK (num_nonnulls(candidate_id, contact_id) >= 1);
