-- 2026-05-23
--
-- One-shot reset for 1,376 people stuck at linkedin_search_status='failed'.
-- The 15-min sweep cron (`find-linkedin-url-sweep`) explicitly skips
-- 'failed' rows so they never get retried — fine when Unipile was the
-- only finder, but now that find-linkedin-url-by-name tries Apollo FIRST
-- (and Apollo's /people/match is strong on email + name+company) most
-- of the failed rows have a real shot of matching this time.
--
-- We only reset rows that have a usable signal for Apollo:
--   - an email, OR
--   - both a name and a current_company
-- Rows with neither stay 'failed' (no signal = no improvement possible).

UPDATE people
SET
  linkedin_search_status = NULL,
  linkedin_search_attempted_at = NULL
WHERE
  linkedin_search_status = 'failed'
  AND (linkedin_url IS NULL OR linkedin_url = '')
  AND is_stub IS NOT TRUE
  AND (
    primary_email IS NOT NULL
    OR work_email IS NOT NULL
    OR personal_email IS NOT NULL
    OR (
      current_company IS NOT NULL
      AND (full_name IS NOT NULL OR (first_name IS NOT NULL AND last_name IS NOT NULL))
    )
  );
