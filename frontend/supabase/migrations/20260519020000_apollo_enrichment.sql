-- Apollo enrichment scaffolding:
--   1. APOLLO_API_KEY row in app_settings (empty default; operator fills
--      it once via the settings UI or direct UPDATE — migration stays
--      committable since no secret is in the file)
--   2. apollo_company_status + apollo_company_enriched_at on companies
--      so enrich-companies-sweep can pick up never-tried + retryable
--      rows without re-enriching what's done

INSERT INTO app_settings (key, value)
VALUES ('APOLLO_API_KEY', '')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS apollo_company_status text,
  ADD COLUMN IF NOT EXISTS apollo_company_enriched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_companies_apollo_pending
  ON public.companies (apollo_company_enriched_at NULLS FIRST)
  WHERE (apollo_company_status IS NULL OR apollo_company_status = 'pending')
    AND (domain IS NOT NULL AND domain <> '')
    AND deleted_at IS NULL;
