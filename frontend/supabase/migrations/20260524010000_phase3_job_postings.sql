-- Phase 3: company job postings ingestion from PDL.
--
-- Two new tables:
--
--   company_career_urls
--     A company can have N career-page URLs. RBC is one company but
--     RBC Capital Markets and RBC Wealth Management have separate
--     career sites. Each URL has its own last_fetched_at so we only
--     pull the delta on each refresh.
--
--   company_job_postings
--     One row per job posting PDL returns for a company. Dedup is by
--     (company_id, external_id). dismissed_at = soft delete (the
--     fetcher's dedup check respects this so a dismissed posting does
--     NOT get resurrected on the next refresh). lead_id links to the
--     jobs row once converted into a recruiting lead.

CREATE TABLE IF NOT EXISTS public.company_career_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  label text,                       -- e.g. "RBC Capital Markets" — operator-visible
  url text NOT NULL,                -- careers page URL (https://...)
  last_fetched_at timestamptz,
  last_fetched_status text,         -- "ok" | "error" | "no_results"
  last_fetched_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, url)
);

CREATE INDEX IF NOT EXISTS idx_company_career_urls_company
  ON public.company_career_urls (company_id);


CREATE TABLE IF NOT EXISTS public.company_job_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  career_url_id uuid REFERENCES public.company_career_urls(id) ON DELETE SET NULL,
  external_id text NOT NULL,        -- PDL's stable posting ID (dedup key)
  title text,
  location text,
  employment_type text,             -- full-time | contract | intern | ...
  seniority text,                   -- junior | mid | senior | ...
  description text,
  posted_at timestamptz,
  source_url text,                  -- direct link to the posting (when PDL has it)
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,         -- soft-delete; fetcher's dedup respects this
  dismissed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  converted_to_lead_at timestamptz,
  converted_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_company_job_postings_company
  ON public.company_job_postings (company_id);

CREATE INDEX IF NOT EXISTS idx_company_job_postings_active
  ON public.company_job_postings (company_id, posted_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_company_job_postings_lead
  ON public.company_job_postings (lead_id)
  WHERE lead_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────
-- Mirrors the companies / jobs policy: any authenticated user in the
-- workspace can read & write. The web app is single-tenant; no
-- per-user scoping needed.

ALTER TABLE public.company_career_urls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_job_postings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read company_career_urls"
  ON public.company_career_urls FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "auth write company_career_urls"
  ON public.company_career_urls FOR ALL
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth read company_job_postings"
  ON public.company_job_postings FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "auth write company_job_postings"
  ON public.company_job_postings FOR ALL
  TO authenticated USING (true) WITH CHECK (true);


-- ── updated_at triggers ───────────────────────────────────────────
-- Match the pattern used by other tables in the schema.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_company_career_urls_updated_at ON public.company_career_urls;
CREATE TRIGGER trg_company_career_urls_updated_at
  BEFORE UPDATE ON public.company_career_urls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_company_job_postings_updated_at ON public.company_job_postings;
CREATE TRIGGER trg_company_job_postings_updated_at
  BEFORE UPDATE ON public.company_job_postings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
