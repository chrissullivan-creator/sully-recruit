-- ============================================================================
-- Ensure all resumes have a candidate_id (NOT NULL constraint)
-- ============================================================================

-- 1. Delete any orphaned resumes that have no candidate_id
DELETE FROM public.resumes WHERE candidate_id IS NULL;

-- 2. Delete any orphaned resume_chunks that have no candidate_id
DELETE FROM public.resume_chunks WHERE candidate_id IS NULL;

-- 3. Add NOT NULL constraint to resumes.candidate_id
ALTER TABLE public.resumes ALTER COLUMN candidate_id SET NOT NULL;

-- 4. Add NOT NULL constraint to resume_chunks.candidate_id
ALTER TABLE public.resume_chunks ALTER COLUMN candidate_id SET NOT NULL;
