-- Pass 8: fix DB functions that wrote invalid status values.
-- After tightening candidates.status to (new|reached_out|engaged), several functions
-- still set status='back_of_resume' or filter on 'stale' which would either throw
-- (CHECK violation) or silently match nothing.

-- 1. auto_back_of_resume: was setting NEW.status, now sets NEW.back_of_resume (boolean column)
CREATE OR REPLACE FUNCTION public.auto_back_of_resume()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, extensions
AS $function$
BEGIN
  IF NEW.status IN ('new', 'reached_out')
    AND (NEW.current_base_comp IS NOT NULL OR NEW.target_base_comp IS NOT NULL)
    AND EXISTS (SELECT 1 FROM resumes WHERE candidate_id = NEW.id)
  THEN
    NEW.back_of_resume := true;
    NEW.back_of_resume_completed_at := COALESCE(NEW.back_of_resume_completed_at, NOW());
    NEW.back_of_resume_updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. mark_candidate_back_of_resume: was setting status='back_of_resume', now sets boolean column
CREATE OR REPLACE FUNCTION public.mark_candidate_back_of_resume(p_candidate_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, extensions
AS $function$
BEGIN
  UPDATE public.candidates
  SET
    back_of_resume = true,
    back_of_resume_completed_at = COALESCE(back_of_resume_completed_at, NOW()),
    back_of_resume_updated_at = NOW(),
    updated_at = NOW()
  WHERE id = p_candidate_id;
END;
$function$;

-- 3. fn_candidate_status_from_timestamps: remove 'stale' from filter (no longer valid)
CREATE OR REPLACE FUNCTION public.fn_candidate_status_from_timestamps()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, extensions
AS $function$
BEGIN
  IF NEW.last_responded_at IS DISTINCT FROM OLD.last_responded_at
     AND NEW.last_responded_at IS NOT NULL
     AND NEW.status IN ('new','reached_out') THEN
    NEW.status := 'engaged';
    NEW.stale_at := NULL;
  END IF;

  IF NEW.last_contacted_at IS DISTINCT FROM OLD.last_contacted_at
     AND NEW.last_contacted_at IS NOT NULL
     AND NEW.status = 'new' THEN
    NEW.status := 'reached_out';
  END IF;

  RETURN NEW;
END;
$function$;

-- 4. import_contact: was inserting into nonexistent columns (company, source) and
--    invalid status='active'. Rewritten for the unified candidates schema.
CREATE OR REPLACE FUNCTION public.import_contact(p_row jsonb, p_owner_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, extensions
AS $function$
DECLARE
  v_email text := LOWER(TRIM(p_row->>'email'));
  v_existing_id uuid;
BEGIN
  IF v_email IS NOT NULL AND v_email <> '' THEN
    SELECT id INTO v_existing_id
    FROM candidates
    WHERE normalized_email = v_email AND type = 'client'
    LIMIT 1;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    UPDATE candidates SET
      first_name    = COALESCE(NULLIF(p_row->>'first_name',''), first_name),
      last_name     = COALESCE(NULLIF(p_row->>'last_name',''), last_name),
      title         = COALESCE(NULLIF(p_row->>'title',''), title),
      company_name  = COALESCE(NULLIF(p_row->>'company',''), company_name),
      email         = COALESCE(NULLIF(p_row->>'email',''), email),
      phone         = COALESCE(NULLIF(p_row->>'phone',''), phone),
      linkedin_url  = COALESCE(NULLIF(p_row->>'linkedin_url',''), linkedin_url),
      location_text = COALESCE(NULLIF(p_row->>'location',''), location_text),
      updated_at    = now()
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO candidates (
      type, first_name, last_name, title, company_name,
      email, phone, linkedin_url, location_text,
      owner_user_id, created_by_user_id, status, created_at
    ) VALUES (
      'client',
      p_row->>'first_name', p_row->>'last_name',
      p_row->>'title', p_row->>'company',
      p_row->>'email', p_row->>'phone',
      p_row->>'linkedin_url', p_row->>'location',
      p_owner_id, p_owner_id, 'new', now()
    );
  END IF;
END;
$function$;
