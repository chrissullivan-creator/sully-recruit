-- Wire two missing pieces of the candidate-onboarding chain:
--
-- 1. notify_person_created() currently only fires AFTER INSERT, so a row
--    that lands as a stub (`is_stub=true`, awaiting resume parse) never
--    triggers the webhook even though the comment in migration
--    20260511030000 promised it would re-fire when is_stub flips false.
--    Add an AFTER UPDATE leg for two transitions:
--      a) is_stub: true → false   (resume parser finished identity)
--      b) linkedin_url: NULL/'' → non-empty   (manual edit or parser-set URL)
--    Both unblock the downstream history + Unipile resolve work.
--
-- 2. resolve-unipile-ids cron picks rows where unipile_resolve_status is
--    NULL or 'pending'. Adding a BEFORE trigger that auto-sets 'pending'
--    whenever linkedin_url goes non-empty means the cron sees fresh rows
--    immediately, instead of relying on the NULL default which a future
--    bulk-update on people might clobber. Idempotent — won't overwrite
--    'resolved' or 'invalid_url' terminal states.

-- (1) Extend notify_person_created to fire on the two UPDATE transitions
--     above. INSERT semantics unchanged — same payload shape, just adds
--     an "operation" hint so the webhook handler can disambiguate.
CREATE OR REPLACE FUNCTION public.notify_person_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  webhook_url text;
  webhook_secret text;
  should_fire boolean := false;
BEGIN
  -- INSERT: fire for every non-stub row (existing behavior).
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_stub, false) = false THEN
      should_fire := true;
    END IF;

  -- UPDATE: fire only on the meaningful transitions, never on every edit.
  ELSIF TG_OP = 'UPDATE' THEN
    -- (a) Stub resolution: parser flipped is_stub to false.
    IF COALESCE(OLD.is_stub, false) = true
       AND COALESCE(NEW.is_stub, false) = false THEN
      should_fire := true;

    -- (b) LinkedIn URL newly populated on a non-stub row.
    ELSIF COALESCE(NEW.is_stub, false) = false
       AND (OLD.linkedin_url IS NULL OR OLD.linkedin_url = '')
       AND NEW.linkedin_url IS NOT NULL
       AND NEW.linkedin_url <> '' THEN
      should_fire := true;
    END IF;
  END IF;

  IF NOT should_fire THEN
    RETURN NEW;
  END IF;

  SELECT value INTO webhook_url
    FROM app_settings WHERE key = 'PERSON_CREATED_WEBHOOK_URL';
  SELECT value INTO webhook_secret
    FROM app_settings WHERE key = 'PERSON_CREATED_WEBHOOK_SECRET';

  IF webhook_url IS NULL OR webhook_url = ''
  OR webhook_secret IS NULL OR webhook_secret = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := webhook_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || webhook_secret
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', 'people',
      'schema', 'public',
      'record', row_to_json(NEW)::jsonb,
      'old_record', CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD)::jsonb ELSE NULL END
    )
  );

  RETURN NEW;
END;
$$;

-- Replace the existing INSERT trigger with one that listens to UPDATE as
-- well. Scoped to is_stub + linkedin_url so unrelated row edits don't
-- evaluate the function at all.
DROP TRIGGER IF EXISTS people_after_insert_notify ON public.people;
DROP TRIGGER IF EXISTS people_after_change_notify ON public.people;
CREATE TRIGGER people_after_change_notify
AFTER INSERT OR UPDATE OF is_stub, linkedin_url ON public.people
FOR EACH ROW EXECUTE FUNCTION public.notify_person_created();

-- (2) Auto-stamp unipile_resolve_status='pending' when a row gains a
--     non-empty linkedin_url. Skips terminal states so we don't reopen
--     work on profiles Unipile already confirmed it can't see.
CREATE OR REPLACE FUNCTION public.set_unipile_pending_on_linkedin_url()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.linkedin_url IS NULL OR NEW.linkedin_url = '' THEN
    RETURN NEW;
  END IF;

  -- Only flip if status is missing or already retryable. Leave the
  -- terminal states ('resolved', 'invalid_url') alone — operators flip
  -- 'not_found' back to 'pending' manually when they want a retry sweep.
  IF NEW.unipile_resolve_status IS NULL
     OR NEW.unipile_resolve_status = '' THEN
    NEW.unipile_resolve_status := 'pending';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_set_unipile_pending ON public.people;
CREATE TRIGGER people_set_unipile_pending
BEFORE INSERT OR UPDATE OF linkedin_url ON public.people
FOR EACH ROW EXECUTE FUNCTION public.set_unipile_pending_on_linkedin_url();
