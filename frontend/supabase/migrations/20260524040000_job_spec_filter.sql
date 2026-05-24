-- Natural-language lead search filter for the company-postings flow.
--
-- The operator writes a free-text spec like "Senior engineering leaders
-- in fintech NYC, $200k+" in Settings → Lead Search Filter. An AI step
-- (Claude → fallback cascade) translates that to a structured PDL
-- job/search filter JSON. Every bulk "Fetch postings" run loads the
-- JSON and merges it into the Elasticsearch query, so we don't pull
-- every JP Morgan posting when the firm only places senior ICs in NYC.
--
-- Three rows:
--   JOB_SPEC_NATURAL_LANGUAGE    the operator's typed text (for editing)
--   JOB_SPEC_PDL_FILTERS         AI-translated JSON ({} when empty)
--   JOB_SPEC_LAST_TRANSLATED_AT  ISO timestamp of last successful translate

INSERT INTO public.app_settings (key, value) VALUES
  ('JOB_SPEC_NATURAL_LANGUAGE',   ''),
  ('JOB_SPEC_PDL_FILTERS',        '{}'),
  ('JOB_SPEC_LAST_TRANSLATED_AT', '')
ON CONFLICT (key) DO NOTHING;
