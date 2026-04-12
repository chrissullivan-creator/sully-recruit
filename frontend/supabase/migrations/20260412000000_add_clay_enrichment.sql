-- Track Clay enrichment status on candidates and contacts
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS clay_enriched_at timestamptz;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS clay_enriched_at timestamptz;
