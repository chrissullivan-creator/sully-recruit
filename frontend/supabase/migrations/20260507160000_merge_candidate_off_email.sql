-- Patch merge_candidate + auto_blacklist_deleted_candidate so that
-- merging duplicate people works after the email-column drop.
--
-- Two breakages caught while merging the 2 personal_email duplicate
-- pairs (Wenbo Zhang, Georgi Georgiev):
--
--   1. merge_candidate UPDATE-ed candidates.email, which is now a
--      generated column over people.primary_email — Postgres rejects
--      the write. Drop those lines; personal_email/work_email
--      already merge via COALESCE in the same statement.
--
--   2. After fixing the UPDATE, the unique constraint on
--      normalized_email collided because the BEFORE-UPDATE trigger
--      fires whenever personal_email is in the SET clause, even when
--      the COALESCE keeps the same value. Free the merged row's
--      typed-email columns first so the survivor can claim that
--      normalized_email under the unique index.
--
--   3. auto_blacklist_deleted_candidate (BEFORE DELETE on people)
--      still read OLD.email — every DELETE was failing, including
--      merge_candidate's final cleanup step. Compute the canonical
--      address from the typed columns instead.

CREATE OR REPLACE FUNCTION public.merge_candidate(p_survivor_id uuid, p_merged_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
DECLARE
  v_survivor candidates%ROWTYPE;
  v_merged   candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_survivor FROM candidates WHERE id = p_survivor_id;
  SELECT * INTO v_merged   FROM candidates WHERE id = p_merged_id;

  IF v_survivor.id IS NULL THEN RAISE EXCEPTION 'Survivor % not found', p_survivor_id; END IF;
  IF v_merged.id   IS NULL THEN RAISE EXCEPTION 'Merged % not found',   p_merged_id;   END IF;

  -- Free the merged row's email values BEFORE re-stamping the
  -- survivor — the BEFORE-UPDATE trigger on people fires on every
  -- UPDATE OF personal_email/work_email and rebuilds normalized_email,
  -- which would collide with the merged row's existing value under
  -- the candidates_normalized_email_unique index.
  UPDATE candidates
    SET personal_email = NULL, work_email = NULL
    WHERE id = p_merged_id;

  -- Survivor takes any field merged has and survivor doesn't. The
  -- candidates.email view column is GENERATED — omit it.
  UPDATE candidates SET
    phone              = COALESCE(phone,              v_merged.phone),
    linkedin_url       = COALESCE(linkedin_url,       v_merged.linkedin_url),
    personal_email     = COALESCE(personal_email,     v_merged.personal_email),
    work_email         = COALESCE(work_email,         v_merged.work_email),
    mobile_phone       = COALESCE(mobile_phone,       v_merged.mobile_phone),
    first_name         = COALESCE(first_name,         v_merged.first_name),
    last_name          = COALESCE(last_name,          v_merged.last_name),
    full_name          = COALESCE(full_name,          v_merged.full_name),
    current_title      = COALESCE(current_title,      v_merged.current_title),
    current_company    = COALESCE(current_company,    v_merged.current_company),
    location_text      = COALESCE(location_text,      v_merged.location_text),
    current_base_comp  = COALESCE(current_base_comp,  v_merged.current_base_comp),
    current_bonus_comp = COALESCE(current_bonus_comp, v_merged.current_bonus_comp),
    current_total_comp = COALESCE(current_total_comp, v_merged.current_total_comp),
    target_base_comp   = COALESCE(target_base_comp,   v_merged.target_base_comp),
    target_bonus_comp  = COALESCE(target_bonus_comp,  v_merged.target_bonus_comp),
    target_total_comp  = COALESCE(target_total_comp,  v_merged.target_total_comp),
    reason_for_leaving = COALESCE(reason_for_leaving, v_merged.reason_for_leaving),
    candidate_summary  = COALESCE(candidate_summary,  v_merged.candidate_summary),
    work_authorization = COALESCE(work_authorization, v_merged.work_authorization),
    resume_url         = COALESCE(resume_url,         v_merged.resume_url),
    avatar_url         = COALESCE(avatar_url,         v_merged.avatar_url),
    profile_picture_url= COALESCE(profile_picture_url,v_merged.profile_picture_url),
    linkedin_profile_data = COALESCE(linkedin_profile_data, v_merged.linkedin_profile_data),
    unipile_sales_nav_id  = COALESCE(unipile_sales_nav_id,  v_merged.unipile_sales_nav_id),
    unipile_classic_id    = COALESCE(unipile_classic_id,    v_merged.unipile_classic_id),
    unipile_provider_id   = COALESCE(unipile_provider_id,   v_merged.unipile_provider_id),
    status = CASE
      WHEN status = 'placed'                  THEN status
      WHEN v_merged.status = 'placed'         THEN v_merged.status
      WHEN status = 'back_of_resume'          THEN status
      WHEN v_merged.status = 'back_of_resume' THEN v_merged.status
      WHEN status = 'reached_out'             THEN status
      WHEN v_merged.status = 'reached_out'    THEN v_merged.status
      ELSE status
    END,
    notes = CASE
      WHEN notes IS NULL THEN v_merged.notes
      WHEN v_merged.notes IS NULL THEN notes
      ELSE notes || E'\n\n--- Merged ---\n' || v_merged.notes
    END,
    back_of_resume_notes = CASE
      WHEN back_of_resume_notes IS NULL THEN v_merged.back_of_resume_notes
      WHEN v_merged.back_of_resume_notes IS NULL THEN back_of_resume_notes
      ELSE back_of_resume_notes || E'\n\n--- Merged ---\n' || v_merged.back_of_resume_notes
    END,
    skills = ARRAY(SELECT DISTINCT unnest(COALESCE(skills,'{}') || COALESCE(v_merged.skills,'{}'))),
    last_contacted_at = GREATEST(last_contacted_at, v_merged.last_contacted_at),
    last_responded_at = GREATEST(last_responded_at, v_merged.last_responded_at),
    last_spoken_at    = GREATEST(last_spoken_at,    v_merged.last_spoken_at),
    updated_at = now()
  WHERE id = p_survivor_id;

  -- Reassign every child table from merged → survivor.
  UPDATE conversations          SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE messages               SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE resumes                SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE resume_embeddings      SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE ai_call_notes          SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE call_logs              SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE call_processing_queue  SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE sequence_enrollments   SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE reply_sentiment        SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE formatted_resumes      SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE candidate_documents    SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE candidate_work_history SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE candidate_education    SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE interviews             SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE send_outs              SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE placements             SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;
  UPDATE notes SET entity_id = p_survivor_id WHERE entity_id = p_merged_id AND entity_type = 'candidate';

  DELETE FROM candidate_jobs WHERE candidate_id = p_merged_id
    AND job_id IN (SELECT job_id FROM candidate_jobs WHERE candidate_id = p_survivor_id);
  UPDATE candidate_jobs SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;

  DELETE FROM job_candidate_matches WHERE candidate_id = p_merged_id
    AND job_id IN (SELECT job_id FROM job_candidate_matches WHERE candidate_id = p_survivor_id);
  UPDATE job_candidate_matches SET candidate_id = p_survivor_id WHERE candidate_id = p_merged_id;

  UPDATE candidates SET linked_contact_id = v_merged.linked_contact_id
  WHERE id = p_survivor_id AND linked_contact_id IS NULL AND v_merged.linked_contact_id IS NOT NULL;

  INSERT INTO candidate_merge_log (survivor_id, merged_id, merged_data, tables_updated, merged_by)
  VALUES (p_survivor_id, p_merged_id, to_jsonb(v_merged), '{"auto_merge":true}'::jsonb, NULL);

  UPDATE duplicate_candidates SET status='merged', survivor_id=p_survivor_id, merged_at=now()
  WHERE (candidate_id_a IN (p_survivor_id,p_merged_id) AND candidate_id_b IN (p_survivor_id,p_merged_id))
     OR candidate_id_a = p_merged_id OR candidate_id_b = p_merged_id;

  DELETE FROM candidates WHERE id = p_merged_id;
  RETURN 'merged ' || p_merged_id || ' into ' || p_survivor_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_blacklist_deleted_candidate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $$
DECLARE
  derived_email TEXT := COALESCE(
    NULLIF(TRIM(OLD.personal_email), ''),
    NULLIF(TRIM(OLD.work_email), '')
  );
BEGIN
  INSERT INTO deleted_candidate_blacklist (email, linkedin_url, full_name, deleted_by)
  VALUES (
    NULLIF(LOWER(TRIM(derived_email)), ''),
    LOWER(TRIM(OLD.linkedin_url)),
    OLD.full_name,
    auth.uid()
  )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;
