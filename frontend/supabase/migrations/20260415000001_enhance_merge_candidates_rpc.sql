-- Enhanced merge_duplicate_candidate RPC:
-- In addition to FK repointing and deletion, also merges candidate fields
-- (fills empty survivor fields, appends notes, unions skills, picks best timestamps).
-- Handles candidate_channels potential duplicate conflicts before FK repointing.

CREATE OR REPLACE FUNCTION public.merge_duplicate_candidate(
  p_survivor_id uuid,
  p_merged_id uuid,
  p_duplicate_row_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_survivor record;
  v_merged record;
  v_rowcount bigint := 0;
  v_total_updates bigint := 0;
  v_updates jsonb := '[]'::jsonb;
  v_candidate_snapshot jsonb;
  v_constraint record;
  v_merged_skills text[];
  v_survivor_skills text[];
  v_union_skills text[];
  v_new_notes text;
  v_fields_updated text[] := '{}';
BEGIN
  -- ── Validation ──────────────────────────────────────────────────
  IF p_survivor_id IS NULL OR p_merged_id IS NULL THEN
    RAISE EXCEPTION 'Both survivor and merged candidate ids are required';
  END IF;

  IF p_survivor_id = p_merged_id THEN
    RAISE EXCEPTION 'Survivor and merged candidate ids must be different';
  END IF;

  -- ── Fetch both records ──────────────────────────────────────────
  SELECT * INTO v_survivor FROM public.candidates WHERE id = p_survivor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survivor candidate not found: %', p_survivor_id;
  END IF;

  SELECT * INTO v_merged FROM public.candidates WHERE id = p_merged_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Merged candidate not found: %', p_merged_id;
  END IF;

  -- Snapshot merged candidate before any changes
  SELECT to_jsonb(c.*) INTO v_candidate_snapshot
  FROM public.candidates c WHERE c.id = p_merged_id;

  -- ── Fill empty survivor fields from merged ──────────────────────
  -- Only overwrite NULL or empty-string fields on the survivor

  IF COALESCE(NULLIF(v_survivor.email, ''), '') = '' AND COALESCE(NULLIF(v_merged.email, ''), '') != '' THEN
    v_fields_updated := v_fields_updated || 'email';
  END IF;
  IF v_survivor.phone IS NULL AND v_merged.phone IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'phone';
  END IF;
  IF COALESCE(NULLIF(v_survivor.linkedin_url, ''), '') = '' AND COALESCE(NULLIF(v_merged.linkedin_url, ''), '') != '' THEN
    v_fields_updated := v_fields_updated || 'linkedin_url';
  END IF;
  IF COALESCE(NULLIF(v_survivor.current_title, ''), '') = '' AND COALESCE(NULLIF(v_merged.current_title, ''), '') != '' THEN
    v_fields_updated := v_fields_updated || 'current_title';
  END IF;
  IF COALESCE(NULLIF(v_survivor.current_company, ''), '') = '' AND COALESCE(NULLIF(v_merged.current_company, ''), '') != '' THEN
    v_fields_updated := v_fields_updated || 'current_company';
  END IF;
  IF v_survivor.location_text IS NULL AND v_merged.location_text IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'location_text';
  END IF;
  IF v_survivor.source IS NULL AND v_merged.source IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'source';
  END IF;
  IF v_survivor.avatar_url IS NULL AND v_merged.avatar_url IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'avatar_url';
  END IF;
  IF v_survivor.linkedin_headline IS NULL AND v_merged.linkedin_headline IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'linkedin_headline';
  END IF;
  IF v_survivor.unipile_id IS NULL AND v_merged.unipile_id IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'unipile_id';
  END IF;
  IF v_survivor.work_authorization IS NULL AND v_merged.work_authorization IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'work_authorization';
  END IF;
  IF v_survivor.candidate_summary IS NULL AND v_merged.candidate_summary IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'candidate_summary';
  END IF;
  IF v_survivor.reason_for_leaving IS NULL AND v_merged.reason_for_leaving IS NOT NULL THEN
    v_fields_updated := v_fields_updated || 'reason_for_leaving';
  END IF;

  UPDATE public.candidates SET
    email             = CASE WHEN COALESCE(NULLIF(email, ''), '') = '' THEN v_merged.email ELSE email END,
    phone             = COALESCE(phone, v_merged.phone),
    linkedin_url      = CASE WHEN COALESCE(NULLIF(linkedin_url, ''), '') = '' THEN v_merged.linkedin_url ELSE linkedin_url END,
    current_title     = CASE WHEN COALESCE(NULLIF(current_title, ''), '') = '' THEN v_merged.current_title ELSE current_title END,
    current_company   = CASE WHEN COALESCE(NULLIF(current_company, ''), '') = '' THEN v_merged.current_company ELSE current_company END,
    location_text     = COALESCE(location_text, v_merged.location_text),
    source            = COALESCE(source, v_merged.source),
    avatar_url        = COALESCE(avatar_url, v_merged.avatar_url),
    linkedin_headline = COALESCE(linkedin_headline, v_merged.linkedin_headline),
    unipile_id        = COALESCE(unipile_id, v_merged.unipile_id),
    work_authorization = COALESCE(work_authorization, v_merged.work_authorization),
    candidate_summary  = COALESCE(candidate_summary, v_merged.candidate_summary),
    reason_for_leaving = COALESCE(reason_for_leaving, v_merged.reason_for_leaving),
    -- Pick the most recent timestamps
    last_contacted_at = GREATEST(last_contacted_at, v_merged.last_contacted_at),
    last_responded_at = GREATEST(last_responded_at, v_merged.last_responded_at),
    last_spoken_at    = GREATEST(last_spoken_at, v_merged.last_spoken_at),
    updated_at        = now()
  WHERE id = p_survivor_id;

  -- ── Merge notes ─────────────────────────────────────────────────
  IF COALESCE(NULLIF(TRIM(v_merged.notes), ''), '') != '' THEN
    IF COALESCE(NULLIF(TRIM(v_survivor.notes), ''), '') != '' THEN
      v_new_notes := v_survivor.notes || E'\n\n--- Merged from duplicate ---\n' || v_merged.notes;
    ELSE
      v_new_notes := v_merged.notes;
    END IF;
    UPDATE public.candidates SET notes = v_new_notes WHERE id = p_survivor_id;
    v_fields_updated := v_fields_updated || 'notes';
  END IF;

  -- ── Union skills arrays ─────────────────────────────────────────
  v_survivor_skills := COALESCE(v_survivor.skills, '{}');
  v_merged_skills := COALESCE(v_merged.skills, '{}');
  IF array_length(v_merged_skills, 1) > 0 THEN
    SELECT ARRAY(
      SELECT DISTINCT unnest
      FROM unnest(v_survivor_skills || v_merged_skills)
      ORDER BY 1
    ) INTO v_union_skills;

    IF array_length(v_union_skills, 1) IS DISTINCT FROM array_length(v_survivor_skills, 1) THEN
      UPDATE public.candidates SET skills = v_union_skills WHERE id = p_survivor_id;
      v_fields_updated := v_fields_updated || 'skills';
    END IF;
  END IF;

  -- ── Handle candidate_channels unique conflicts ──────────────────
  -- Delete merged candidate's channels where survivor already has the same channel
  DELETE FROM public.candidate_channels mc
  USING public.candidate_channels sc
  WHERE mc.candidate_id = p_merged_id
    AND sc.candidate_id = p_survivor_id
    AND mc.channel = sc.channel;

  -- ── Repoint all single-column FK references ─────────────────────
  FOR v_constraint IN
    SELECT
      n.nspname AS table_schema,
      cls.relname AS table_name,
      att.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    JOIN pg_attribute att ON att.attrelid = con.conrelid
      AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.candidates'::regclass
      AND array_length(con.conkey, 1) = 1
      AND n.nspname = 'public'
      AND NOT (cls.relname = 'duplicate_candidates' AND att.attname IN ('candidate_id_a', 'candidate_id_b'))
      AND NOT (cls.relname = 'candidate_merge_log' AND att.attname = 'survivor_id')
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
      v_constraint.table_schema,
      v_constraint.table_name,
      v_constraint.column_name,
      v_constraint.column_name
    ) USING p_survivor_id, p_merged_id;

    GET DIAGNOSTICS v_rowcount = ROW_COUNT;

    IF v_rowcount > 0 THEN
      v_total_updates := v_total_updates + v_rowcount;
      v_updates := v_updates || jsonb_build_array(
        jsonb_build_object(
          'table', format('%s.%s', v_constraint.table_schema, v_constraint.table_name),
          'column', v_constraint.column_name,
          'rows', v_rowcount
        )
      );
    END IF;
  END LOOP;

  -- ── Delete the merged candidate ─────────────────────────────────
  DELETE FROM public.candidates WHERE id = p_merged_id;

  -- ── Mark duplicate_candidates row as merged ─────────────────────
  IF p_duplicate_row_id IS NOT NULL THEN
    UPDATE public.duplicate_candidates
    SET
      status = 'merged',
      survivor_id = p_survivor_id,
      merged_at = now(),
      merged_by = auth.uid()
    WHERE id = p_duplicate_row_id;
  END IF;

  -- Also mark any other duplicate_candidates rows involving merged candidate
  UPDATE public.duplicate_candidates
  SET
    status = 'merged',
    survivor_id = p_survivor_id,
    merged_at = now(),
    merged_by = auth.uid()
  WHERE status = 'pending'
    AND (candidate_id_a = p_merged_id OR candidate_id_b = p_merged_id);

  -- ── Write audit log ─────────────────────────────────────────────
  INSERT INTO public.candidate_merge_log (
    survivor_id,
    merged_id,
    merged_data,
    tables_updated,
    merged_by
  ) VALUES (
    p_survivor_id,
    p_merged_id,
    v_candidate_snapshot,
    jsonb_build_object('fk_updates', v_updates, 'fields_filled', to_jsonb(v_fields_updated)),
    auth.uid()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'survivor_id', p_survivor_id,
    'merged_id', p_merged_id,
    'updated_rows', v_total_updates,
    'tables_updated', v_updates,
    'fields_filled', v_fields_updated
  );
END;
$$;
