-- Fire /api/webhooks/person-created right after a new row lands in
-- `people`, so brand-new candidates / clients get their email +
-- LinkedIn history pulled within seconds (instead of waiting up to
-- an hour for the backfill-entity-histories cron).
--
-- Architecture: AFTER INSERT trigger → notify_person_created() →
-- pg_net.http_post → Vercel endpoint /api/webhooks/person-created
-- → inngest.send("messages/fetch-entity-history.requested").
--
-- The endpoint validates an Authorization: Bearer <secret> header.
-- The trigger reads the secret + base URL from app_settings so the
-- migration doesn't have to hardcode either:
--   app_settings.PERSON_CREATED_WEBHOOK_URL    (e.g. https://www.sullyrecruit.app/api/webhooks/person-created)
--   app_settings.PERSON_CREATED_WEBHOOK_SECRET (any random string)
-- Both must be set after this migration runs. If either is missing the
-- trigger silently no-ops so an unconfigured environment doesn't break
-- candidate inserts.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_person_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  webhook_url text;
  webhook_secret text;
BEGIN
  -- Pre-flight skip: stub rows wait for resume-ingestion to fill in
  -- the real identity. It'll re-trigger the webhook once is_stub
  -- flips to false on parse completion.
  IF COALESCE(NEW.is_stub, false) = true THEN
    RETURN NEW;
  END IF;

  -- Resolve config from app_settings. NULL → trigger no-ops (so the
  -- migration is safe to land before the secrets are configured).
  SELECT value INTO webhook_url
    FROM app_settings WHERE key = 'PERSON_CREATED_WEBHOOK_URL';
  SELECT value INTO webhook_secret
    FROM app_settings WHERE key = 'PERSON_CREATED_WEBHOOK_SECRET';

  IF webhook_url IS NULL OR webhook_url = ''
  OR webhook_secret IS NULL OR webhook_secret = '' THEN
    RETURN NEW;
  END IF;

  -- Fire-and-forget HTTP POST. pg_net schedules the request on its
  -- own worker so the INSERT transaction commits without waiting on
  -- network. Errors surface in net._http_response — query that table
  -- if the webhook isn't firing.
  PERFORM net.http_post(
    url := webhook_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || webhook_secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'people',
      'schema', 'public',
      'record', row_to_json(NEW)::jsonb
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_after_insert_notify ON public.people;
CREATE TRIGGER people_after_insert_notify
AFTER INSERT ON public.people
FOR EACH ROW EXECUTE FUNCTION public.notify_person_created();

-- Seed the app_settings rows so the operator just has to fill in the
-- values. Doing it as INSERT ... ON CONFLICT DO NOTHING keeps the
-- migration idempotent across re-runs.
INSERT INTO app_settings (key, value)
VALUES ('PERSON_CREATED_WEBHOOK_URL', ''),
       ('PERSON_CREATED_WEBHOOK_SECRET', '')
ON CONFLICT (key) DO NOTHING;
