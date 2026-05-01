-- Fix advisor warnings introduced by pipeline stage tables:
-- 1. Consolidate read+write policies into a single FOR ALL policy
-- 2. Add missing FK indexes

DROP POLICY IF EXISTS "authenticated read pitches"     ON pitches;
DROP POLICY IF EXISTS "authenticated write pitches"    ON pitches;
DROP POLICY IF EXISTS "authenticated read submissions" ON submissions;
DROP POLICY IF EXISTS "authenticated write submissions" ON submissions;
DROP POLICY IF EXISTS "authenticated read rejections"  ON rejections;
DROP POLICY IF EXISTS "authenticated write rejections" ON rejections;

CREATE POLICY "authenticated all pitches"     ON pitches     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated all submissions" ON submissions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated all rejections"  ON rejections  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Index FKs that lacked them
CREATE INDEX IF NOT EXISTS idx_pitches_candidate_job_id     ON pitches(candidate_job_id)     WHERE candidate_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pitches_pitched_by           ON pitches(pitched_by)           WHERE pitched_by       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submissions_candidate_job_id ON submissions(candidate_job_id) WHERE candidate_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_by     ON submissions(submitted_by)     WHERE submitted_by     IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rejections_candidate_job_id  ON rejections(candidate_job_id)  WHERE candidate_job_id IS NOT NULL;
