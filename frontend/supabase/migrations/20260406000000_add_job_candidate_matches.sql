-- ============================================================================
-- Job-Candidate matching: store AI-ranked best matches per job
-- ============================================================================

-- Match results table
CREATE TABLE IF NOT EXISTS public.job_candidate_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,

  -- Scoring
  vector_similarity FLOAT,
  overall_score INT NOT NULL,
  tier TEXT NOT NULL,  -- 'strong', 'good', 'worth_considering'

  -- Claude analysis
  reasoning TEXT NOT NULL,
  strengths TEXT[],
  concerns TEXT[],

  -- Metadata
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(job_id, candidate_id, run_id)
);

CREATE INDEX idx_jcm_job_id ON public.job_candidate_matches(job_id);
CREATE INDEX idx_jcm_candidate_id ON public.job_candidate_matches(candidate_id);
CREATE INDEX idx_jcm_job_score ON public.job_candidate_matches(job_id, overall_score DESC);
CREATE INDEX idx_jcm_run_id ON public.job_candidate_matches(run_id);

-- Run tracking table
CREATE TABLE IF NOT EXISTS public.job_match_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed'
  candidates_scanned INT DEFAULT 0,
  matches_found INT DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX idx_jmr_job_id ON public.job_match_runs(job_id, started_at DESC);

-- RLS: authenticated users can read, service_role manages writes
ALTER TABLE public.job_candidate_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read job_candidate_matches" ON public.job_candidate_matches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages job_candidate_matches" ON public.job_candidate_matches FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.job_match_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read job_match_runs" ON public.job_match_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert job_match_runs" ON public.job_match_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role manages job_match_runs" ON public.job_match_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
