-- Guard against epoch / garbage communication timestamps.
--
-- A historical backfill stamped last_responded_at = '1970-01-01' on ~1,808
-- people who never actually replied, which falsely promoted them to
-- status='engaged'. No live code writes epoch (webhooks/backfills write real
-- received_at/sent_at), but this BEFORE trigger sanitizes any sub-2010 value
-- to NULL so a future bad backfill can't reintroduce the bug. Named with a
-- '00' prefix so it sorts/fires before the status-from-timestamps trigger.
CREATE OR REPLACE FUNCTION public.fn_sanitize_comm_timestamps()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.last_responded_at IS NOT NULL AND NEW.last_responded_at < '2010-01-01' THEN
    NEW.last_responded_at := NULL;
  END IF;
  IF NEW.last_contacted_at IS NOT NULL AND NEW.last_contacted_at < '2010-01-01' THEN
    NEW.last_contacted_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_sanitize_comm_timestamps ON public.people;
CREATE TRIGGER trg_00_sanitize_comm_timestamps
  BEFORE INSERT OR UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.fn_sanitize_comm_timestamps();
