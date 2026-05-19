-- Eager Apollo enrichment on company INSERT.
--
-- Same shape as 20260511030000_person_created_webhook_trigger: an AFTER
-- INSERT trigger calls pg_net.http_post → /api/webhooks/company-created
-- → inngest.send("companies/enrich-via-apollo.requested"). Without this,
-- new companies wait up to an hour for enrich-companies-sweep.
--
-- Config in app_settings (NULL → trigger no-ops so the migration is
-- safe to land before the secrets are configured):
--   COMPANY_CREATED_WEBHOOK_URL    (e.g. https://www.sullyrecruit.app/api/webhooks/company-created)
--   COMPANY_CREATED_WEBHOOK_SECRET (any random string; must also be set
--                                   as Vercel env COMPANY_CREATED_WEBHOOK_SECRET)

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_company_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  webhook_url text;
  webhook_secret text;
BEGIN
  -- Skip soft-deleted rows just in case the trigger fires on a row
  -- that was inserted in a deleted state (rare, but cheap to guard).
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Apollo enrichment needs a domain. Skip rows that come in without
  -- one — the sweep cron will pick them up if a domain is backfilled
  -- (apollo_company_status starts NULL so the sweep still sees them).
  IF NEW.domain IS NULL OR NEW.domain = '' THEN
    RETURN NEW;
  END IF;

  SELECT value INTO webhook_url
    FROM app_settings WHERE key = 'COMPANY_CREATED_WEBHOOK_URL';
  SELECT value INTO webhook_secret
    FROM app_settings WHERE key = 'COMPANY_CREATED_WEBHOOK_SECRET';

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
      'type', 'INSERT',
      'table', 'companies',
      'schema', 'public',
      'record', row_to_json(NEW)::jsonb
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_after_insert_notify ON public.companies;
CREATE TRIGGER companies_after_insert_notify
AFTER INSERT ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.notify_company_created();

-- Seed app_settings rows so the operator just has to fill in values.
INSERT INTO app_settings (key, value)
VALUES ('COMPANY_CREATED_WEBHOOK_URL', ''),
       ('COMPANY_CREATED_WEBHOOK_SECRET', '')
ON CONFLICT (key) DO NOTHING;
