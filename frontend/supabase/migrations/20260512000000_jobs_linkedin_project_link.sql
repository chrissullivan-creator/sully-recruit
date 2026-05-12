-- Link an internal job to a LinkedIn Recruiter project so Source's
-- "Save to Pipeline" can auto-tag candidates to the right job.
--
-- A LinkedIn project ID is only unique within a Unipile account, so we
-- store both the project_id and the account_id and uniqueness key on the
-- pair. account_id is the Unipile acc_xxx string (matches
-- integration_accounts.unipile_account_id).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS linkedin_project_id TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_project_account_id TEXT;

-- One job per (account, project) — recruiters can't (and shouldn't) link
-- the same LinkedIn project to two internal jobs simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_linkedin_project_uniq
  ON public.jobs (linkedin_project_account_id, linkedin_project_id)
  WHERE linkedin_project_id IS NOT NULL;

-- Filter index for the reverse lookup (project → job) used by the
-- Save-to-Pipeline endpoint.
CREATE INDEX IF NOT EXISTS jobs_linkedin_project_lookup
  ON public.jobs (linkedin_project_id)
  WHERE linkedin_project_id IS NOT NULL;

COMMENT ON COLUMN public.jobs.linkedin_project_id IS
  'Unipile LinkedIn Recruiter hiring-project ID this job is linked to.';
COMMENT ON COLUMN public.jobs.linkedin_project_account_id IS
  'Unipile acc_xxx that owns the linked LinkedIn project.';
