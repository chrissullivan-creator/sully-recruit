-- Pass 2b: per-stage pipeline tables.
-- Existing: send_outs, interviews, placements. New: pitches, submissions, rejections.
-- Each row = a candidate entering that stage for a job. Populated by app or future trigger.

CREATE TABLE IF NOT EXISTS pitches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id      uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES jobs(id)       ON DELETE CASCADE,
  candidate_job_id  uuid          REFERENCES candidate_jobs(id) ON DELETE SET NULL,
  pitched_at        timestamptz NOT NULL DEFAULT now(),
  pitched_by        uuid REFERENCES auth.users(id),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pitches_candidate ON pitches(candidate_id);
CREATE INDEX IF NOT EXISTS idx_pitches_job       ON pitches(job_id);
ALTER TABLE pitches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read pitches"  ON pitches FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated write pitches" ON pitches FOR ALL    TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id      uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES jobs(id)       ON DELETE CASCADE,
  candidate_job_id  uuid          REFERENCES candidate_jobs(id) ON DELETE SET NULL,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  submitted_by      uuid REFERENCES auth.users(id),
  submitted_to      text,        -- which client contact / team
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submissions_candidate ON submissions(candidate_id);
CREATE INDEX IF NOT EXISTS idx_submissions_job       ON submissions(job_id);
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read submissions"  ON submissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated write submissions" ON submissions FOR ALL    TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS rejections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id      uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES jobs(id)       ON DELETE CASCADE,
  candidate_job_id  uuid          REFERENCES candidate_jobs(id) ON DELETE SET NULL,
  rejected_at       timestamptz NOT NULL DEFAULT now(),
  rejected_by_party text CHECK (rejected_by_party IN ('candidate','client','recruiter')),
  rejection_reason  text,
  prior_stage       text,        -- pitch, sendout, submitted, interview, placement
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rejections_candidate ON rejections(candidate_id);
CREATE INDEX IF NOT EXISTS idx_rejections_job       ON rejections(job_id);
ALTER TABLE rejections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read rejections"  ON rejections FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated write rejections" ON rejections FOR ALL    TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE pitches     IS 'Stage table: candidate pitched for a job. Pre-sendout outreach.';
COMMENT ON TABLE submissions IS 'Stage table: candidate formally submitted to client for a job.';
COMMENT ON TABLE rejections  IS 'Stage table: candidate-job rejected (any prior stage). Records who rejected and why.';
