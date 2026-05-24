-- Phase 5: needs_classification flag on people.
-- When we auto-add a person from sending to an unknown recipient, we
-- default the type to 'candidate' and flag the row so the user can
-- quickly confirm or flip to 'client' from the Data Cleanup view.

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS needs_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_added_source text;
  -- auto_added_source: 'outbound_email' | 'outbound_linkedin' |
  --                    'outbound_recruiter' | 'outbound_sms' | 'group_thread'

CREATE INDEX IF NOT EXISTS idx_people_needs_classification
  ON public.people(needs_classification)
  WHERE needs_classification = true;
