-- Phase 2 enrichment cascade replacement
--
-- Drops LeadMagic and Bytemine as enrichment providers. Adds:
--   • Apollo person_id + organization_id columns so re-enrichment can
--     hit Apollo's bulk endpoints by ID instead of re-searching.
--   • app_settings rows for the four new providers. Empty defaults —
--     operator fills via the settings UI or direct UPDATE. Migration
--     stays committable.
--
-- LeadMagic + Bytemine app_settings rows are intentionally NOT
-- removed in this migration. The code paths that read them are gone,
-- but leaving the rows in place lets us roll back without touching the
-- DB. A follow-up migration can DELETE them once Phase 2 is proven.

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS apollo_person_id text;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS apollo_organization_id text;

-- Unique-when-not-null: each Apollo ID maps to exactly one row, but
-- most rows have NULL. A partial unique index gives us dedup without
-- forcing NULL handling on every insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_apollo_person_id_unique
  ON public.people (apollo_person_id)
  WHERE apollo_person_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_apollo_organization_id_unique
  ON public.companies (apollo_organization_id)
  WHERE apollo_organization_id IS NOT NULL;

INSERT INTO app_settings (key, value) VALUES
  ('BETTERCONTACT_API_KEY', ''),
  ('FULLENRICH_API_KEY',    ''),
  ('PDL_API_KEY',           ''),
  ('ZEROBOUNCE_API_KEY',    '')
ON CONFLICT (key) DO NOTHING;
