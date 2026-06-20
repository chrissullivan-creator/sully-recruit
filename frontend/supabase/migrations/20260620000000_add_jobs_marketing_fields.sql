-- Marketing fields on jobs — the public, candidate/website-facing version of a
-- role's details, kept separate from the internal title/location/compensation/
-- description so recruiters can polish copy for the website without altering the
-- operational record. All free text; marketing_job_description holds rich HTML
-- (same as jobs.description), the rest are short single-line strings.
--
-- Edited under Job Detail → Marketing tab. Consumed by the public website.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS marketing_title            text,
  ADD COLUMN IF NOT EXISTS marketing_type_of_firm     text,
  ADD COLUMN IF NOT EXISTS marketing_job_description   text,
  ADD COLUMN IF NOT EXISTS marketing_job_compensation  text,
  ADD COLUMN IF NOT EXISTS marketing_job_location      text;

COMMENT ON COLUMN public.jobs.marketing_title           IS 'Public/website-facing job title. Marketing copy — distinct from internal jobs.title.';
COMMENT ON COLUMN public.jobs.marketing_type_of_firm    IS 'Public/website-facing description of the firm type (e.g. "Multi-strategy hedge fund").';
COMMENT ON COLUMN public.jobs.marketing_job_description IS 'Public/website-facing job description. Rich HTML — distinct from internal jobs.description.';
COMMENT ON COLUMN public.jobs.marketing_job_compensation IS 'Public/website-facing compensation copy (e.g. "Competitive base + bonus").';
COMMENT ON COLUMN public.jobs.marketing_job_location    IS 'Public/website-facing location copy (e.g. "New York, NY (Hybrid)").';
