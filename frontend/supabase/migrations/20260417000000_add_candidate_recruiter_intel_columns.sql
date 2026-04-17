-- Add recruiter intel columns extracted from call transcripts by Claude.
-- These fields are populated automatically by process-call-deepgram and
-- editable on the CandidateDetail Background tab.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS visa_status text,
  ADD COLUMN IF NOT EXISTS fun_facts text,
  ADD COLUMN IF NOT EXISTS where_interviewed text,
  ADD COLUMN IF NOT EXISTS where_submitted text;
