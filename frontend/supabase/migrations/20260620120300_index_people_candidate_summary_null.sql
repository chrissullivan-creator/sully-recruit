-- Audit fix 1g (forward-looking): the candidate-summary backfill selects
-- `candidate_summary IS NULL` rows from the 13k-row people table via a seq scan.
-- It's fine now (most rows still match + LIMIT), but as the pool shrinks the scan
-- must read the whole table each run and will start tripping the 8s statement_timeout.
-- A partial index keeps the selection cheap all the way to completion.
CREATE INDEX IF NOT EXISTS idx_people_candidate_summary_null
  ON public.people (id)
  WHERE candidate_summary IS NULL;
