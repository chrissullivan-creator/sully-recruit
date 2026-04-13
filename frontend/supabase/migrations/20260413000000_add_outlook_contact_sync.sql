-- Sync candidates to Microsoft Outlook contacts.
-- Adds tracking columns and DB triggers that fire pg_net HTTP calls
-- to the Vercel API route, which triggers the Trigger.dev sync task.

-- 1. Tracking columns on candidates
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS ms_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS ms_contact_synced_at TIMESTAMPTZ;

-- Index for backfill queries (find unsynced candidates)
CREATE INDEX IF NOT EXISTS idx_candidates_ms_contact_id_null
  ON public.candidates (id)
  WHERE ms_contact_id IS NULL;

-- 2. Ensure pg_net extension is enabled
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 3. Trigger: sync on new candidate creation
CREATE OR REPLACE FUNCTION public.trigger_outlook_contact_on_candidate()
RETURNS TRIGGER AS $$
DECLARE
  api_base_url text;
BEGIN
  SELECT value INTO api_base_url
  FROM public.app_settings
  WHERE key = 'API_BASE_URL';

  IF api_base_url IS NOT NULL AND api_base_url != '' THEN
    PERFORM net.http_post(
      url := api_base_url || '/api/trigger-sync-outlook-contact',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('candidate_id', NEW.id)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS candidate_sync_outlook_contact ON public.candidates;
CREATE TRIGGER candidate_sync_outlook_contact
  AFTER INSERT ON public.candidates
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_outlook_contact_on_candidate();

-- 4. Trigger: sync on sequence enrollment
CREATE OR REPLACE FUNCTION public.trigger_outlook_contact_on_enrollment()
RETURNS TRIGGER AS $$
DECLARE
  api_base_url text;
BEGIN
  IF NEW.candidate_id IS NULL THEN RETURN NEW; END IF;

  SELECT value INTO api_base_url
  FROM public.app_settings
  WHERE key = 'API_BASE_URL';

  IF api_base_url IS NOT NULL AND api_base_url != '' THEN
    PERFORM net.http_post(
      url := api_base_url || '/api/trigger-sync-outlook-contact',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('candidate_id', NEW.candidate_id)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS enrollment_sync_outlook_contact ON public.sequence_enrollments;
CREATE TRIGGER enrollment_sync_outlook_contact
  AFTER INSERT ON public.sequence_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_outlook_contact_on_enrollment();

-- 5. Trigger: sync when a candidate is linked to a meeting task
CREATE OR REPLACE FUNCTION public.trigger_outlook_contact_on_task_link()
RETURNS TRIGGER AS $$
DECLARE
  api_base_url text;
  t_type text;
BEGIN
  IF NEW.entity_type != 'candidate' THEN RETURN NEW; END IF;

  -- Only fire for meeting tasks
  SELECT task_type INTO t_type FROM public.tasks WHERE id = NEW.task_id;
  IF t_type IS DISTINCT FROM 'meeting' THEN RETURN NEW; END IF;

  SELECT value INTO api_base_url
  FROM public.app_settings
  WHERE key = 'API_BASE_URL';

  IF api_base_url IS NOT NULL AND api_base_url != '' THEN
    PERFORM net.http_post(
      url := api_base_url || '/api/trigger-sync-outlook-contact',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('candidate_id', NEW.entity_id)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS task_link_sync_outlook_contact ON public.task_links;
CREATE TRIGGER task_link_sync_outlook_contact
  AFTER INSERT ON public.task_links
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_outlook_contact_on_task_link();
