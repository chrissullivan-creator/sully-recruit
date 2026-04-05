-- Auto-trigger Joe Says regeneration when notes are inserted.
-- Uses pg_net extension to call the Vercel API route which triggers
-- the generate-joe-says Trigger.dev task.
--
-- Also adds joe_says and joe_says_updated_at columns to contacts table
-- (candidates table already has them).

-- Ensure contacts table has joe_says columns
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS joe_says text,
  ADD COLUMN IF NOT EXISTS joe_says_updated_at timestamptz;

-- Ensure candidates table has notice_period column (for enhanced call extraction)
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS notice_period text;

-- Enable pg_net extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Function to trigger Joe Says generation via API route
-- Uses the app's base URL from app_settings table
CREATE OR REPLACE FUNCTION public.trigger_joe_says_on_note()
RETURNS TRIGGER AS $$
DECLARE
  api_base_url text;
BEGIN
  -- Get the API base URL from app_settings
  SELECT value INTO api_base_url
  FROM public.app_settings
  WHERE key = 'API_BASE_URL';

  -- Only fire if we have a valid API URL
  IF api_base_url IS NOT NULL AND api_base_url != '' THEN
    PERFORM net.http_post(
      url := api_base_url || '/api/trigger-generate-joe-says',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'entityId', NEW.entity_id,
        'entityType', NEW.entity_type
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger on notes table
DROP TRIGGER IF EXISTS note_insert_joe_says ON public.notes;
CREATE TRIGGER note_insert_joe_says
  AFTER INSERT ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_joe_says_on_note();
