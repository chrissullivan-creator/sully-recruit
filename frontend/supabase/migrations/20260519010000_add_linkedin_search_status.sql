-- Track LinkedIn URL discovery state for people we tried to find on
-- LinkedIn via Unipile's recruiter search. Distinct from
-- unipile_resolve_status (which tracks URL → provider_id resolution).
--
-- Lifecycle:
--   NULL          → never tried
--   'pending'     → queued for find-linkedin-url-by-name
--   'found'       → search wrote linkedin_url back; resolve cron will
--                   pick it up via the BEFORE trigger (status='pending')
--   'ambiguous'   → multiple candidates above the match threshold;
--                   skip auto-write to avoid false positives
--   'not_found'   → no result cleared the match threshold
--   'insufficient_data' → can't search (missing name)
--   'failed'      → Unipile API error / rate-limit

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS linkedin_search_status text,
  ADD COLUMN IF NOT EXISTS linkedin_search_attempted_at timestamptz;

-- Index for the cron sweep (NULL or 'pending', no linkedin_url, has a
-- name). NULLS FIRST so never-attempted people get picked before retries.
CREATE INDEX IF NOT EXISTS idx_people_linkedin_search_pending
  ON public.people (linkedin_search_attempted_at NULLS FIRST)
  WHERE (linkedin_search_status IS NULL OR linkedin_search_status = 'pending')
    AND (linkedin_url IS NULL OR linkedin_url = '')
    AND is_stub IS NOT TRUE;
