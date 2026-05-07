-- Flip primary_email priority: personal first, work fallback.
--
-- Sequences should reach candidates on their personal mailbox by
-- default — they're more likely to read it; corporate filters and
-- job changes don't break the touch. Recipients can still be
-- addressed at their work address explicitly via work_email when
-- the caller wants that.
--
-- Steps:
--   1. Drop dependents (views reference primary_email by name).
--   2. Re-add primary_email with personal-first COALESCE.
--   3. Recreate indexes.
--   4. Recreate views (definitions identical — they read the column,
--      so the new ordering takes effect automatically).
--   5. Re-bind the contacts INSTEAD-OF triggers (functions are still
--      there from 20260507140000; binding is lost on view drop).
--   6. Update set_candidate_normalized_email to compute from the
--      personal-first ordering too.
--   7. Patch the long-standing set_candidate_identity_fields trigger
--      and trigger_fetch_entity_history fn — both still referenced
--      NEW.email which is gone, so every people INSERT/UPDATE was
--      failing post-drop. Compute the canonical address inline from
--      the typed columns.

DROP TRIGGER IF EXISTS trg_set_candidate_normalized_email ON public.people;
DROP VIEW IF EXISTS public.candidate_summary;
DROP VIEW IF EXISTS public.contacts;
DROP VIEW IF EXISTS public.candidates;
DROP INDEX IF EXISTS public.idx_people_primary_email_lower;

ALTER TABLE public.people DROP COLUMN IF EXISTS primary_email;
ALTER TABLE public.people
  ADD COLUMN primary_email TEXT
  GENERATED ALWAYS AS
    (COALESCE(NULLIF(TRIM(personal_email), ''), NULLIF(TRIM(work_email), ''))) STORED;

CREATE INDEX idx_people_primary_email_lower
  ON public.people (LOWER(primary_email))
  WHERE primary_email IS NOT NULL;

CREATE VIEW public.candidates AS
SELECT
  id, full_name,
  primary_email AS email,
  phone, linkedin_url, current_company, current_title, location_text, status,
  created_at, updated_at, owner_user_id, first_name, last_name,
  last_contacted_at, last_responded_at, last_comm_channel, resume_url,
  current_base_comp, current_bonus_comp, current_total_comp,
  target_base_comp, target_bonus_comp, target_total_comp,
  comp_notes, work_authorization, relocation_preference, target_locations,
  reason_for_leaving, target_roles, candidate_summary, back_of_resume_notes,
  last_spoken_at, back_of_resume_completed_at, placed_at, inactive_reason,
  job_id, job_status, joe_says, joe_says_updated_at, skills,
  created_by_user_id, claimed_at, notes, normalized_email, normalized_phone,
  normalized_linkedin_url, email_match_key, phone_match_key,
  linkedin_match_key, identity_fingerprint, unipile_sales_nav_id,
  unipile_provider_id, avatar_url, profile_picture_url, linkedin_profile_data,
  unipile_resolve_status, disqualified_by, disqualified_reason,
  linkedin_enriched_at, linkedin_enrichment_source, last_sequence_sentiment,
  last_sequence_sentiment_note, call_structured_notes, unipile_recruiter_id,
  unipile_classic_id, work_email, personal_email, mobile_phone, roles,
  linked_contact_id, is_stub, visa_status, fun_facts, where_interviewed,
  where_submitted, back_of_resume, back_of_resume_updated_at, stale_at,
  type, company_id, title, department, linkedin_headline,
  linkedin_current_company, linkedin_current_title, linkedin_location,
  linkedin_profile_text, linkedin_last_synced_at, ai_search_text, company_name,
  secondary_emails
FROM public.people;

CREATE VIEW public.contacts AS
SELECT
  id, company_id, first_name, last_name, full_name,
  primary_email AS email,
  phone, linkedin_url, title, department, status,
  owner_user_id AS owner_id, created_at, updated_at,
  last_contacted_at AS last_reached_out_at,
  last_responded_at, owner_user_id, notes, last_contacted_at,
  last_responded_at AS last_replied_at,
  linkedin_profile_text, linkedin_headline, linkedin_current_company,
  linkedin_current_title, linkedin_location, linkedin_last_synced_at,
  NULL::tsvector AS linkedin_search,
  ai_search_text, unipile_sales_nav_id, unipile_provider_id, avatar_url,
  profile_picture_url, linkedin_profile_data, unipile_resolve_status,
  company_name, created_by_user_id AS user_id, last_comm_channel,
  linkedin_enriched_at, linkedin_enrichment_source, last_sequence_sentiment,
  last_sequence_sentiment_note, unipile_recruiter_id, unipile_classic_id,
  location_text AS location, work_email, personal_email, mobile_phone, roles,
  linked_contact_id AS linked_candidate_id, is_stub, secondary_emails
FROM public.people
WHERE type = 'client';

CREATE VIEW public.candidate_summary AS
SELECT
  c.id, c.first_name, c.last_name, c.full_name,
  c.primary_email AS email,
  c.phone, c.linkedin_url, c.current_company, c.current_title,
  c.location_text AS location, c.status,
  COUNT(DISTINCT so.id) AS send_out_count,
  MAX(conv.last_message_at) AS last_message_at
FROM public.people c
LEFT JOIN public.send_outs so       ON so.candidate_id = c.id
LEFT JOIN public.conversations conv ON conv.candidate_id = c.id
GROUP BY c.id;

DROP TRIGGER IF EXISTS contacts_view_insert_trg ON public.contacts;
DROP TRIGGER IF EXISTS contacts_view_update_trg ON public.contacts;
DROP TRIGGER IF EXISTS contacts_view_delete_trg ON public.contacts;
CREATE TRIGGER contacts_view_insert_trg
  INSTEAD OF INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_view_insert();
CREATE TRIGGER contacts_view_update_trg
  INSTEAD OF UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_view_update();
CREATE TRIGGER contacts_view_delete_trg
  INSTEAD OF DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_view_delete();

CREATE OR REPLACE FUNCTION public.set_candidate_normalized_email()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
BEGIN
  NEW.normalized_email := NULLIF(LOWER(TRIM(
    COALESCE(NULLIF(TRIM(NEW.personal_email), ''), NULLIF(TRIM(NEW.work_email), ''))
  )), '');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_candidate_normalized_email
  BEFORE INSERT OR UPDATE OF work_email, personal_email
  ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.set_candidate_normalized_email();

-- Pre-existing trigger that still hand-rolled normalization off NEW.email.
-- It overlaps set_candidate_normalized_email but also sets the match keys
-- and identity_fingerprint, so it can't just be dropped — patch it to
-- compute the canonical address from the typed columns.
CREATE OR REPLACE FUNCTION public.set_candidate_identity_fields()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
DECLARE
  derived_email TEXT := COALESCE(
    NULLIF(TRIM(NEW.personal_email), ''),
    NULLIF(TRIM(NEW.work_email), '')
  );
BEGIN
  NEW.normalized_email        := public.normalize_email(derived_email);
  NEW.normalized_phone        := public.normalize_phone(NEW.phone);
  NEW.normalized_linkedin_url := public.normalize_linkedin_url(NEW.linkedin_url);

  NEW.email_match_key    := public.make_match_key(NEW.normalized_email);
  NEW.phone_match_key    := public.make_match_key(NEW.normalized_phone);
  NEW.linkedin_match_key := public.make_match_key(NEW.normalized_linkedin_url);

  NEW.identity_fingerprint := concat_ws(
    '|',
    COALESCE(NEW.normalized_email, ''),
    COALESCE(NEW.normalized_phone, ''),
    COALESCE(NEW.normalized_linkedin_url, '')
  );

  RETURN NEW;
END;
$$;

-- Same fix for the AFTER-INSERT history-fetch hook. It swallows
-- exceptions, so the bug only meant we were silently skipping the
-- history call on every new person row.
CREATE OR REPLACE FUNCTION public.trigger_fetch_entity_history()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
DECLARE
  payload jsonb;
  entity_col text;
  derived_email TEXT := COALESCE(
    NULLIF(TRIM(NEW.personal_email), ''),
    NULLIF(TRIM(NEW.work_email), '')
  );
  supabase_url text := 'https://xlobevmhzimxjtpiontf.supabase.co';
BEGIN
  IF derived_email IS NULL AND (NEW.linkedin_url IS NULL OR NEW.linkedin_url = '') THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'candidates' THEN
    entity_col := 'candidate_id';
  ELSE
    entity_col := 'contact_id';
  END IF;

  payload := jsonb_build_object(entity_col, NEW.id);

  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/fetch-entity-history',
    body    := payload,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;
