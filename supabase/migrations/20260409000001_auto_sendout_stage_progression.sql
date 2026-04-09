-- =============================================================
-- AI-powered send_out stage progression triggers
-- Auto-advance stages based on communication activity.
-- Human overrides always take precedence — triggers only act
-- on specific "from" stages (never regress).
-- =============================================================

-- Rule 1: Outbound message → advance "lead" send_outs to "reached_out"
CREATE OR REPLACE FUNCTION public.advance_sendout_on_outbound_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only fire on outbound messages linked to a candidate
  IF NEW.direction = 'outbound' AND NEW.candidate_id IS NOT NULL THEN
    -- Advance any send_outs still in "lead" stage for this candidate
    UPDATE public.send_outs
    SET stage = 'reached_out', updated_at = now()
    WHERE candidate_id = NEW.candidate_id
      AND stage = 'lead';

    -- Also update candidate job_status if it's still "lead"
    UPDATE public.candidates
    SET job_status = 'reached_out'
    WHERE id = NEW.candidate_id
      AND job_status = 'lead';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_sendout_on_outbound ON public.messages;
CREATE TRIGGER trg_advance_sendout_on_outbound
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.advance_sendout_on_outbound_message();


-- Rule 2: Completed call (>2 min) → advance "reached_out" to "back_of_resume"
CREATE OR REPLACE FUNCTION public.advance_sendout_on_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.linked_entity_type = 'candidate'
     AND NEW.linked_entity_id IS NOT NULL
     AND NEW.status = 'completed'
     AND COALESCE(NEW.duration_seconds, 0) > 120
  THEN
    -- Advance send_outs from reached_out to back_of_resume
    UPDATE public.send_outs
    SET stage = 'back_of_resume', updated_at = now()
    WHERE candidate_id = NEW.linked_entity_id
      AND stage = 'reached_out';

    -- Also update candidate job_status
    UPDATE public.candidates
    SET job_status = 'back_of_resume'
    WHERE id = NEW.linked_entity_id
      AND job_status = 'reached_out';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_sendout_on_call ON public.call_logs;
CREATE TRIGGER trg_advance_sendout_on_call
  AFTER INSERT OR UPDATE ON public.call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.advance_sendout_on_call();


-- Rule 3: Auto-set timestamps when send_out stage changes
CREATE OR REPLACE FUNCTION public.set_sendout_stage_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF OLD.stage IS DISTINCT FROM NEW.stage THEN
    IF NEW.stage = 'sent' AND NEW.sent_to_client_at IS NULL THEN
      NEW.sent_to_client_at := now();
    END IF;
    IF NEW.stage = 'interview' AND NEW.interview_at IS NULL THEN
      NEW.interview_at := now();
    END IF;
    IF NEW.stage = 'offer' AND NEW.offer_at IS NULL THEN
      NEW.offer_at := now();
    END IF;
    IF NEW.stage = 'placed' AND NEW.placed_at IS NULL THEN
      NEW.placed_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_sendout_timestamps ON public.send_outs;
CREATE TRIGGER trg_set_sendout_timestamps
  BEFORE UPDATE ON public.send_outs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_sendout_stage_timestamps();
