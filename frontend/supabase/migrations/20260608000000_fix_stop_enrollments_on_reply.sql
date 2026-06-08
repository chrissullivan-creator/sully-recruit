-- Fix stop_enrollments_on_reply(): the production function referenced
-- sequence_enrollments.updated_at, which DOES NOT EXIST on that table —
-- so every inbound `messages` insert (the trigger fires AFTER INSERT on
-- inbound rows) errored, breaking inbound message persistence (and the
-- new v2 LinkedIn/email backfills that insert inbound messages).
--
-- Fix: drop the four `updated_at = NOW()` assignments (two in the
-- connection_accepted branch, two in the reply branch). All other logic
-- is unchanged.

CREATE OR REPLACE FUNCTION public.stop_enrollments_on_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.direction != 'inbound' THEN
    RETURN NEW;
  END IF;
  IF NEW.candidate_id IS NULL AND NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.message_type = 'connection_accepted' THEN
    IF NEW.candidate_id IS NOT NULL THEN
      UPDATE sequence_enrollments
      SET linkedin_connection_accepted_at = NOW(), linkedin_connection_status = 'accepted'
      WHERE candidate_id = NEW.candidate_id AND linkedin_connection_status = 'pending';
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      UPDATE sequence_enrollments
      SET linkedin_connection_accepted_at = NOW(), linkedin_connection_status = 'accepted'
      WHERE contact_id = NEW.contact_id AND linkedin_connection_status = 'pending';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.candidate_id IS NOT NULL THEN
    UPDATE sequence_enrollments
    SET status = 'stopped', stop_reason = 'reply_received', stop_trigger = 'reply_received', stopped_at = NOW()
    WHERE candidate_id = NEW.candidate_id AND status = 'active';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    UPDATE sequence_enrollments
    SET status = 'stopped', stop_reason = 'reply_received', stop_trigger = 'reply_received', stopped_at = NOW()
    WHERE contact_id = NEW.contact_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;
