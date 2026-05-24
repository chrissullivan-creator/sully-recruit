-- Async enrichment job rows.
--
-- POST /api/people/enrich routes batches > 5 people through Inngest
-- to avoid the Vercel 60s timeout (FullEnrich + BetterContact each
-- poll for up to 30s per person). The endpoint creates a row here,
-- fires `enrichment/run.requested`, returns 202 + jobId.
--
-- The Inngest worker (process-enrichment-job) processes in chunks of
-- 10 people and stamps progress after each chunk. The frontend polls
-- /api/enrichment-jobs/{id} every couple of seconds and renders a
-- sticky toast that updates as the job advances.

CREATE TABLE IF NOT EXISTS public.enrichment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  people_ids uuid[] NOT NULL,
  fields text[] NOT NULL,
  total integer NOT NULL,
  processed integer NOT NULL DEFAULT 0,
  changed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  credits jsonb NOT NULL DEFAULT '{}'::jsonb,
  linkedin_summary jsonb NOT NULL DEFAULT '{"urls_found":0,"profiles_synced":0,"work_history_rows":0}'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('queued','running','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status
  ON public.enrichment_jobs (status, created_at DESC)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_user
  ON public.enrichment_jobs (created_by_user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_enrichment_jobs_updated_at ON public.enrichment_jobs;
CREATE TRIGGER trg_enrichment_jobs_updated_at
  BEFORE UPDATE ON public.enrichment_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.enrichment_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth read own enrichment_jobs" ON public.enrichment_jobs;
CREATE POLICY "auth read own enrichment_jobs"
  ON public.enrichment_jobs FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "auth write own enrichment_jobs" ON public.enrichment_jobs;
CREATE POLICY "auth write own enrichment_jobs"
  ON public.enrichment_jobs FOR ALL
  TO authenticated USING (true) WITH CHECK (true);
