-- Retire people.email entirely. The typed columns (work_email +
-- personal_email) are the canonical surface from now on. Every
-- legacy reader keeps working because the candidates/contacts views
-- now expose a computed `email` derived from COALESCE.
--
-- Steps:
--   1. Capture stray plain-email values into a new secondary_emails
--      TEXT[] (the 114 rows where personal+work were both populated
--      with a different address — import residue we don't want to lose).
--   2. Drop dependents: 2 INSTEAD-OF triggers, 1 normalize trigger,
--      3 views, all of which mention people.email.
--   3. Drop the column.
--   4. Recreate the views with COALESCE(work_email, personal_email)
--      AS email so every existing reader still sees a value.
--   5. Recreate the contacts INSTEAD-OF insert/update triggers to
--      route the legacy NEW.email field into personal_email or
--      work_email by domain heuristic.
--   6. Recreate the normalize trigger off the typed columns.
--   7. Add a `primary_email` STORED-GENERATED column for new clean
--      reads (work first, fall back to personal).

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS secondary_emails TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE public.people
SET secondary_emails = ARRAY_APPEND(secondary_emails, email)
WHERE email IS NOT NULL
  AND LOWER(email) <> LOWER(COALESCE(personal_email, ''))
  AND LOWER(email) <> LOWER(COALESCE(work_email, ''));

DROP TRIGGER IF EXISTS trg_set_candidate_normalized_email ON public.people;
DROP TRIGGER IF EXISTS contacts_view_insert_trg ON public.contacts;
DROP TRIGGER IF EXISTS contacts_view_update_trg ON public.contacts;
DROP TRIGGER IF EXISTS contacts_view_delete_trg ON public.contacts;
DROP VIEW IF EXISTS public.candidate_summary;
DROP VIEW IF EXISTS public.contacts;
DROP VIEW IF EXISTS public.candidates;

ALTER TABLE public.people DROP COLUMN IF EXISTS email;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS primary_email TEXT
  GENERATED ALWAYS AS
    (COALESCE(NULLIF(TRIM(work_email), ''), NULLIF(TRIM(personal_email), ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_people_primary_email_lower
  ON public.people (LOWER(primary_email))
  WHERE primary_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_secondary_emails_gin
  ON public.people USING GIN (secondary_emails);

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

CREATE OR REPLACE FUNCTION public.is_consumer_email_domain(addr TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT addr IS NOT NULL
     AND LOWER(SPLIT_PART(addr, '@', 2)) ~
       '^(gmail|yahoo|hotmail|outlook|icloud|me|mac|aol|msn|live|protonmail|proton|fastmail|comcast|verizon|sbcglobal|att|optonline|ymail|hush|gmx|zoho|tutanota|cox|charter|earthlink|bellsouth|hanmail|naver)\.[a-z.]+$'
$$;

CREATE OR REPLACE FUNCTION public.contacts_view_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  resolved_personal TEXT := NEW.personal_email;
  resolved_work     TEXT := NEW.work_email;
BEGIN
  IF NEW.email IS NOT NULL
     AND LOWER(NEW.email) <> LOWER(COALESCE(resolved_personal, ''))
     AND LOWER(NEW.email) <> LOWER(COALESCE(resolved_work, '')) THEN
    IF public.is_consumer_email_domain(NEW.email) THEN
      resolved_personal := COALESCE(resolved_personal, NEW.email);
    ELSE
      resolved_work := COALESCE(resolved_work, NEW.email);
    END IF;
  END IF;

  INSERT INTO public.people (
    id, type, company_id, first_name, last_name, full_name,
    phone, linkedin_url, title, department,
    status, owner_user_id, created_at, updated_at,
    last_contacted_at, last_responded_at, notes, last_comm_channel,
    location_text, linkedin_headline, linkedin_current_company, linkedin_current_title,
    linkedin_location, linkedin_profile_text, linkedin_last_synced_at, ai_search_text,
    unipile_sales_nav_id, unipile_provider_id, avatar_url, profile_picture_url,
    linkedin_profile_data, unipile_resolve_status, company_name,
    created_by_user_id, linkedin_enriched_at, linkedin_enrichment_source,
    last_sequence_sentiment, last_sequence_sentiment_note,
    unipile_recruiter_id, unipile_classic_id,
    work_email, personal_email, mobile_phone, roles, linked_contact_id, is_stub
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()), 'client', NEW.company_id,
    NEW.first_name, NEW.last_name, NEW.full_name,
    NEW.phone, NEW.linkedin_url, NEW.title, NEW.department,
    CASE WHEN NEW.status IN ('new','reached_out','engaged') THEN NEW.status ELSE 'new' END,
    COALESCE(NEW.owner_user_id, NEW.owner_id),
    COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
    COALESCE(NEW.last_contacted_at, NEW.last_reached_out_at),
    COALESCE(NEW.last_responded_at, NEW.last_replied_at),
    NEW.notes, NEW.last_comm_channel, NEW.location,
    NEW.linkedin_headline, NEW.linkedin_current_company, NEW.linkedin_current_title,
    NEW.linkedin_location, NEW.linkedin_profile_text, NEW.linkedin_last_synced_at, NEW.ai_search_text,
    NEW.unipile_sales_nav_id, NEW.unipile_provider_id, NEW.avatar_url, NEW.profile_picture_url,
    NEW.linkedin_profile_data, NEW.unipile_resolve_status, NEW.company_name,
    NEW.user_id, NEW.linkedin_enriched_at, NEW.linkedin_enrichment_source,
    NEW.last_sequence_sentiment, NEW.last_sequence_sentiment_note,
    NEW.unipile_recruiter_id, NEW.unipile_classic_id,
    resolved_work, resolved_personal, NEW.mobile_phone,
    COALESCE(NEW.roles, ARRAY['client']::text[]),
    NEW.linked_candidate_id, COALESCE(NEW.is_stub, false)
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.contacts_view_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  resolved_personal TEXT := NEW.personal_email;
  resolved_work     TEXT := NEW.work_email;
BEGIN
  IF NEW.email IS NOT NULL
     AND LOWER(NEW.email) <> LOWER(COALESCE(resolved_personal, ''))
     AND LOWER(NEW.email) <> LOWER(COALESCE(resolved_work, '')) THEN
    IF public.is_consumer_email_domain(NEW.email) THEN
      resolved_personal := COALESCE(resolved_personal, NEW.email);
    ELSE
      resolved_work := COALESCE(resolved_work, NEW.email);
    END IF;
  END IF;

  UPDATE public.people SET
    company_id = NEW.company_id, first_name = NEW.first_name, last_name = NEW.last_name,
    full_name = NEW.full_name, phone = NEW.phone, linkedin_url = NEW.linkedin_url,
    title = NEW.title, department = NEW.department,
    status = CASE WHEN NEW.status IN ('new','reached_out','engaged') THEN NEW.status ELSE 'new' END,
    owner_user_id = COALESCE(NEW.owner_user_id, NEW.owner_id),
    updated_at = COALESCE(NEW.updated_at, now()),
    last_contacted_at = COALESCE(NEW.last_contacted_at, NEW.last_reached_out_at),
    last_responded_at = COALESCE(NEW.last_responded_at, NEW.last_replied_at),
    notes = NEW.notes, last_comm_channel = NEW.last_comm_channel, location_text = NEW.location,
    linkedin_headline = NEW.linkedin_headline, linkedin_current_company = NEW.linkedin_current_company,
    linkedin_current_title = NEW.linkedin_current_title, linkedin_location = NEW.linkedin_location,
    linkedin_profile_text = NEW.linkedin_profile_text, linkedin_last_synced_at = NEW.linkedin_last_synced_at,
    ai_search_text = NEW.ai_search_text,
    unipile_sales_nav_id = NEW.unipile_sales_nav_id, unipile_provider_id = NEW.unipile_provider_id,
    avatar_url = NEW.avatar_url, profile_picture_url = NEW.profile_picture_url,
    linkedin_profile_data = NEW.linkedin_profile_data, unipile_resolve_status = NEW.unipile_resolve_status,
    company_name = NEW.company_name, created_by_user_id = NEW.user_id,
    linkedin_enriched_at = NEW.linkedin_enriched_at, linkedin_enrichment_source = NEW.linkedin_enrichment_source,
    last_sequence_sentiment = NEW.last_sequence_sentiment, last_sequence_sentiment_note = NEW.last_sequence_sentiment_note,
    unipile_recruiter_id = NEW.unipile_recruiter_id, unipile_classic_id = NEW.unipile_classic_id,
    work_email = resolved_work, personal_email = resolved_personal, mobile_phone = NEW.mobile_phone,
    roles = NEW.roles, linked_contact_id = NEW.linked_candidate_id, is_stub = NEW.is_stub
  WHERE id = OLD.id AND type = 'client';
  RETURN NEW;
END;
$$;

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
    COALESCE(NULLIF(TRIM(NEW.work_email), ''), NULLIF(TRIM(NEW.personal_email), ''))
  )), '');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_candidate_normalized_email
  BEFORE INSERT OR UPDATE OF work_email, personal_email
  ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.set_candidate_normalized_email();
