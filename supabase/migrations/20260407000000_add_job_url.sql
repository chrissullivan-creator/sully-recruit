-- Add job_url column to store the original job posting link
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS job_url TEXT;
