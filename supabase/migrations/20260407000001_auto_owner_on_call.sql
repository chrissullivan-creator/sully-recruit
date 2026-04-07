-- Auto-assign candidate ownership when a call over 2 minutes completes
-- The person who made/received the call becomes the candidate's owner.

CREATE OR REPLACE FUNCTION public.assign_owner_on_long_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on completed calls linked to a candidate, over 2 minutes
  IF NEW.linked_entity_type = 'candidate'
     AND NEW.linked_entity_id IS NOT NULL
     AND NEW.owner_id IS NOT NULL
     AND COALESCE(NEW.duration_seconds, 0) > 120
     AND NEW.status = 'completed'
  THEN
    UPDATE candidates
    SET owner_id = NEW.owner_id
    WHERE id = NEW.linked_entity_id
      AND (owner_id IS DISTINCT FROM NEW.owner_id);
  END IF;

  RETURN NEW;
END;
$$;

-- Fire on INSERT or UPDATE so it catches both immediate inserts and
-- calls that are updated to completed status after the fact.
CREATE TRIGGER trg_assign_owner_on_long_call
  AFTER INSERT OR UPDATE OF status, duration_seconds
  ON public.call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_owner_on_long_call();
