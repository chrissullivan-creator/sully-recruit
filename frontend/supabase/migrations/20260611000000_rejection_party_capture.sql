-- Rejection party capture (the pipeline stage formerly labeled "Withdrawn" is
-- now "Rejected"). Records WHO drove the rejection on the pipeline rows and
-- allows 'salesperson' as a rejecting party everywhere.
--
-- The canonical stage key stays 'withdrawn' (with 'rejected' as a synonym) for
-- back-compat with existing data + the send_outs.stage / candidates.job_status
-- CHECK constraints; only the user-facing label changes to "Rejected".
--
-- Already applied live via MCP.

ALTER TABLE public.send_outs ADD COLUMN IF NOT EXISTS withdrawn_by_party text;
ALTER TABLE public.send_outs DROP CONSTRAINT IF EXISTS send_outs_withdrawn_by_party_check;
ALTER TABLE public.send_outs ADD CONSTRAINT send_outs_withdrawn_by_party_check
  CHECK (withdrawn_by_party IS NULL OR withdrawn_by_party IN ('candidate','client','recruiter','salesperson'));

ALTER TABLE public.candidate_jobs ADD COLUMN IF NOT EXISTS withdrawn_by_party text;
ALTER TABLE public.candidate_jobs DROP CONSTRAINT IF EXISTS candidate_jobs_withdrawn_by_party_check;
ALTER TABLE public.candidate_jobs ADD CONSTRAINT candidate_jobs_withdrawn_by_party_check
  CHECK (withdrawn_by_party IS NULL OR withdrawn_by_party IN ('candidate','client','recruiter','salesperson'));

ALTER TABLE public.rejections DROP CONSTRAINT IF EXISTS rejections_rejected_by_party_check;
ALTER TABLE public.rejections ADD CONSTRAINT rejections_rejected_by_party_check
  CHECK (rejected_by_party IN ('candidate','client','recruiter','salesperson'));
