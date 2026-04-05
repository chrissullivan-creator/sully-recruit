-- Add missing columns to sequence_enrollments for sentiment tracking
ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS reply_sentiment TEXT,
  ADD COLUMN IF NOT EXISTS reply_sentiment_note TEXT;

-- Add missing columns to sequences for multi-job and candidate tagging
ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS job_ids UUID[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS candidate_ids UUID[] DEFAULT '{}';

-- Backfill job_ids from existing job_id
UPDATE public.sequences
SET job_ids = ARRAY[job_id]
WHERE job_id IS NOT NULL AND (job_ids IS NULL OR job_ids = '{}');
