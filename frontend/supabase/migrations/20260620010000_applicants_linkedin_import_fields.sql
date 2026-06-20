-- Extend the applicants table so LinkedIn Recruiter project applicants can be
-- imported alongside website applies without data loss.
--
-- The table is shaped for website applications (name/email/phone/comp/resume
-- file). LinkedIn applicants carry different data — title/company/location/
-- headline/photo/applied-date and a provider id used to fetch their resume
-- on demand (we don't copy resume files for imports). A `source` column marks
-- where each row came from. All new columns are nullable (source defaults to
-- 'website') so the public website insert path is unaffected.

ALTER TABLE public.applicants
  ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'website',
  ADD COLUMN IF NOT EXISTS provider_id         text,
  ADD COLUMN IF NOT EXISTS headline            text,
  ADD COLUMN IF NOT EXISTS current_title       text,
  ADD COLUMN IF NOT EXISTS current_company     text,
  ADD COLUMN IF NOT EXISTS location            text,
  ADD COLUMN IF NOT EXISTS profile_picture_url text,
  ADD COLUMN IF NOT EXISTS applied_at          timestamptz;

COMMENT ON COLUMN public.applicants.source      IS 'Where the applicant came from: ''website'' (public careers form) or ''linkedin'' (imported from a LinkedIn Recruiter project).';
COMMENT ON COLUMN public.applicants.provider_id IS 'LinkedIn applicant/profile id — used to fetch the resume on demand for imported applicants (no file is copied at import time).';

-- Speeds up de-dupe lookups when importing.
CREATE INDEX IF NOT EXISTS applicants_provider_id_idx ON public.applicants (provider_id);
CREATE INDEX IF NOT EXISTS applicants_source_idx ON public.applicants (source);
