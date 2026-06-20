-- Teach fn_stamp_candidate_jobs_timestamps the CANONICAL stage vocabulary.
--
-- The original trigger keyed off the RAW stage values ('reached_out','pitch',
-- 'ready_to_send','sent','interviewing','placed','rejected'), but the app
-- (move-stage.ts) writes the CANONICAL values ('submitted','interview',
-- 'offer','withdrawn'). The result: candidate_jobs.sent_at / interviewing_at /
-- ready_to_send_at and rejected_from_stage / rejected_at stopped being stamped
-- for app-driven moves, so they drifted into being unreliable.
--
-- This rewrites the function to recognise BOTH vocabularies (the synonym groups
-- match frontend/src/lib/pipeline.ts CANONICAL_PIPELINE), then backfills the
-- "reached this stage" timestamps for existing rows from the real transition
-- times recorded in status_change_log.
--
-- (These per-stage timestamp columns are analytics-only — no app code reads
--  candidate_jobs.sent_at / interviewing_at / ready_to_send_at — so the change
--  is purely additive.)

CREATE OR REPLACE FUNCTION public.fn_stamp_candidate_jobs_timestamps()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_stage  text    := lower(NEW.pipeline_stage);
  -- Terminal exit synonyms (canonical 'withdrawn' + raw 'rejected' family).
  v_is_exit boolean := v_stage IN ('withdrawn', 'withdrew', 'rejected', 'declined', 'reject');
BEGIN
  IF TG_OP = 'INSERT' OR NEW.pipeline_stage IS DISTINCT FROM OLD.pipeline_stage THEN
    -- Stamp the "reached this stage" timestamp. Each branch matches the raw AND
    -- canonical synonyms for that funnel stage so app-driven (canonical) and
    -- legacy (raw) writes both land.
    IF v_stage = 'reached_out' THEN
      NEW.reached_out_at := COALESCE(NEW.reached_out_at, NOW());
    ELSIF v_stage IN ('pitch', 'pitched', 'new') THEN
      NEW.pitched_at := COALESCE(NEW.pitched_at, NOW());
    ELSIF v_stage IN ('ready_to_send', 'send_out', 'sendout') THEN
      NEW.ready_to_send_at := COALESCE(NEW.ready_to_send_at, NOW());
    ELSIF v_stage IN ('submitted', 'sent') THEN
      NEW.sent_at := COALESCE(NEW.sent_at, NOW());
    ELSIF v_stage IN ('interview', 'interviewing', 'interview_round_1', 'interview_round_2_plus') THEN
      NEW.interviewing_at := COALESCE(NEW.interviewing_at, NOW());
    ELSIF v_stage = 'placed' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    END IF;

    -- Terminal exit closes the row and records where it exited from.
    IF v_is_exit THEN
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
      IF TG_OP = 'INSERT'
         OR lower(OLD.pipeline_stage) NOT IN ('withdrawn', 'withdrew', 'rejected', 'declined', 'reject') THEN
        NEW.rejected_from_stage := COALESCE(NEW.rejected_from_stage,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.pipeline_stage ELSE NULL END);
        NEW.rejected_at := COALESCE(NEW.rejected_at, NOW());
      END IF;
    END IF;

    NEW.stage_updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Backfill the reached-stage timestamps for existing rows from the real
-- transition times in status_change_log (the earliest time each row entered
-- each stage). Only fills columns that are currently NULL — never overwrites
-- an existing stamp.
-- ---------------------------------------------------------------------------
WITH reached AS (
  SELECT entity_id AS cj_id,
         MIN(created_at) FILTER (WHERE lower(to_status) = 'reached_out')                                                     AS reached_out_at,
         MIN(created_at) FILTER (WHERE lower(to_status) IN ('pitch','pitched','new'))                                        AS pitched_at,
         MIN(created_at) FILTER (WHERE lower(to_status) IN ('ready_to_send','send_out','sendout'))                           AS ready_to_send_at,
         MIN(created_at) FILTER (WHERE lower(to_status) IN ('submitted','sent'))                                             AS sent_at,
         MIN(created_at) FILTER (WHERE lower(to_status) IN ('interview','interviewing','interview_round_1','interview_round_2_plus')) AS interviewing_at
  FROM public.status_change_log
  WHERE entity_type = 'candidate_job'
  GROUP BY entity_id
)
UPDATE public.candidate_jobs cj
SET reached_out_at   = COALESCE(cj.reached_out_at,   reached.reached_out_at),
    pitched_at       = COALESCE(cj.pitched_at,       reached.pitched_at),
    ready_to_send_at = COALESCE(cj.ready_to_send_at, reached.ready_to_send_at),
    sent_at          = COALESCE(cj.sent_at,          reached.sent_at),
    interviewing_at  = COALESCE(cj.interviewing_at,  reached.interviewing_at)
FROM reached
WHERE reached.cj_id = cj.id
  AND (cj.reached_out_at   IS NULL AND reached.reached_out_at   IS NOT NULL
    OR cj.pitched_at       IS NULL AND reached.pitched_at       IS NOT NULL
    OR cj.ready_to_send_at IS NULL AND reached.ready_to_send_at IS NOT NULL
    OR cj.sent_at          IS NULL AND reached.sent_at          IS NOT NULL
    OR cj.interviewing_at  IS NULL AND reached.interviewing_at  IS NOT NULL);
