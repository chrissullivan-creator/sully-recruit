-- Track the furthest funnel stage each candidate_job ever reached, so that
-- conversion rates (e.g. the Job Detail "Interview Rate") still count a
-- candidate who interviewed and then withdrew.
--
-- Why a dedicated column instead of reading pipeline_stage / rejected_from_stage:
--   candidate_jobs.pipeline_stage stores only the CURRENT stage, so a withdrawn
--   candidate reads as 'withdrawn' and loses the fact that they reached interview.
--   The existing fn_stamp_candidate_jobs_timestamps trigger and the
--   rejected_from_stage column key off the RAW stage vocabulary
--   ('sent','interviewing','rejected'), but the app (move-stage.ts) writes the
--   CANONICAL vocabulary ('submitted','interview','withdrawn') — so those legacy
--   columns are only sparsely populated and can't be trusted as history.
--
-- This migration adds candidate_jobs.max_pipeline_stage, a forward-only
-- ("ratchet") record of the deepest funnel stage reached, maintained by a
-- trigger that understands BOTH vocabularies, and backfills it from every
-- available source of history.

-- ---------------------------------------------------------------------------
-- 1. Funnel-rank helper. Mirrors frontend/src/lib/pipeline.ts CANONICAL_PIPELINE.
--    Returns 0..5 for funnel stages, NULL for terminal exits / pre-funnel /
--    unknown values (so withdrawn never counts as "reached" and never ratchets).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_funnel_rank(stage text)
RETURNS int
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE lower(stage)
    WHEN 'pitch'                  THEN 0
    WHEN 'pitched'                THEN 0
    WHEN 'new'                    THEN 0
    WHEN 'ready_to_send'          THEN 1
    WHEN 'send_out'               THEN 1
    WHEN 'sendout'                THEN 1
    WHEN 'submitted'              THEN 2
    WHEN 'sent'                   THEN 2
    WHEN 'interview'              THEN 3
    WHEN 'interviewing'           THEN 3
    WHEN 'interview_round_1'      THEN 3
    WHEN 'interview_round_2_plus' THEN 3
    WHEN 'offer'                  THEN 4
    WHEN 'placed'                 THEN 5
    ELSE NULL  -- withdrawn / withdrew / rejected / declined / reject / lead / reached_out / etc.
  END;
$$;

-- Reverse map: funnel rank -> canonical funnel key (the value stored in the column).
CREATE OR REPLACE FUNCTION public.pipeline_funnel_key(rank int)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE rank
    WHEN 0 THEN 'pitch'
    WHEN 1 THEN 'ready_to_send'
    WHEN 2 THEN 'submitted'
    WHEN 3 THEN 'interview'
    WHEN 4 THEN 'offer'
    WHEN 5 THEN 'placed'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Column.
-- ---------------------------------------------------------------------------
ALTER TABLE public.candidate_jobs ADD COLUMN IF NOT EXISTS max_pipeline_stage text;
COMMENT ON COLUMN public.candidate_jobs.max_pipeline_stage IS
  'Forward-only (ratcheting) record of the deepest CANONICAL funnel stage this candidate_job ever reached (pitch < ready_to_send < submitted < interview < offer < placed). Maintained by trg_ratchet_candidate_jobs_max_stage. Lets conversion rates count candidates who advanced past a stage and then withdrew. Terminal exits (withdrawn/rejected) never lower it.';

-- ---------------------------------------------------------------------------
-- 3. Ratchet trigger — advances max_pipeline_stage but never lowers it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ratchet_candidate_jobs_max_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  new_rank int := public.pipeline_funnel_rank(NEW.pipeline_stage);
  cur_rank int := public.pipeline_funnel_rank(NEW.max_pipeline_stage);
BEGIN
  -- Keep any explicitly-provided higher value; otherwise advance to the new
  -- stage when it's a funnel stage deeper than what we've recorded.
  IF new_rank IS NOT NULL AND (cur_rank IS NULL OR new_rank > cur_rank) THEN
    NEW.max_pipeline_stage := public.pipeline_funnel_key(new_rank);
  ELSIF NEW.max_pipeline_stage IS NOT NULL AND cur_rank IS NULL THEN
    -- A non-funnel value somehow landed in the column — normalise it away.
    NEW.max_pipeline_stage := public.pipeline_funnel_key(new_rank);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ratchet_candidate_jobs_max_stage ON public.candidate_jobs;
CREATE TRIGGER trg_ratchet_candidate_jobs_max_stage
  BEFORE INSERT OR UPDATE ON public.candidate_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ratchet_candidate_jobs_max_stage();

-- ---------------------------------------------------------------------------
-- 4. Backfill from every source of truth: the current stage, the stage the row
--    was rejected from, the per-stage timestamps, and the full status_change_log
--    history (keyed on candidate_jobs.id). Take the deepest rank seen anywhere.
-- ---------------------------------------------------------------------------
WITH evidence AS (
  SELECT cj.id,
         GREATEST(
           COALESCE(public.pipeline_funnel_rank(cj.pipeline_stage),      -1),
           COALESCE(public.pipeline_funnel_rank(cj.rejected_from_stage), -1),
           CASE WHEN cj.sent_at        IS NOT NULL THEN 2 ELSE -1 END,
           CASE WHEN cj.interviewing_at IS NOT NULL THEN 3 ELSE -1 END,
           COALESCE((
             SELECT MAX(public.pipeline_funnel_rank(scl.to_status))
             FROM public.status_change_log scl
             WHERE scl.entity_type = 'candidate_job'
               AND scl.entity_id = cj.id
           ), -1)
         ) AS rank
  FROM public.candidate_jobs cj
)
UPDATE public.candidate_jobs cj
SET max_pipeline_stage = public.pipeline_funnel_key(evidence.rank)
FROM evidence
WHERE evidence.id = cj.id
  AND evidence.rank >= 0
  AND cj.max_pipeline_stage IS DISTINCT FROM public.pipeline_funnel_key(evidence.rank);
