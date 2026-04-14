-- RPC helper for merging duplicate candidates from Supabase MCP or app workflows.
-- Strategy:
-- 1) Repoint all FK references from merged candidate -> survivor candidate.
-- 2) Capture a JSON snapshot of the merged record.
-- 3) Delete the merged record.
-- 4) Mark duplicate_candidates row as merged (if provided).
-- 5) Write an audit row to candidate_merge_log.

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
  v_rowcount bigint := 0;
  v_total_updates bigint := 0;
  v_updates jsonb := '[]'::jsonb;
  v_candidate_snapshot jsonb;
  v_constraint record;
BEGIN
  IF p_survivor_id IS NULL OR p_merged_id IS NULL THEN
    RAISE EXCEPTION 'Both survivor and merged candidate ids are required';
  END IF;

  IF p_survivor_id = p_merged_id THEN
    RAISE EXCEPTION 'Survivor and merged candidate ids must be different';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.candidates c WHERE c.id = p_survivor_id) THEN
    RAISE EXCEPTION 'Survivor candidate not found: %', p_survivor_id;
  END IF;

  SELECT to_jsonb(c.*)
  INTO v_candidate_snapshot
  FROM public.candidates c
  WHERE c.id = p_merged_id;

  IF v_candidate_snapshot IS NULL THEN
    RAISE EXCEPTION 'Merged candidate not found: %', p_merged_id;
  END IF;

  -- Move all single-column FK references that point to candidates.id.
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

  DELETE FROM public.candidates
  WHERE id = p_merged_id;

  IF p_duplicate_row_id IS NOT NULL THEN
    UPDATE public.duplicate_candidates
    SET
      status = 'merged',
      survivor_id = p_survivor_id,
      merged_at = now(),
      merged_by = auth.uid()
    WHERE id = p_duplicate_row_id;
  END IF;

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
    v_updates,
    auth.uid()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'survivor_id', p_survivor_id,
    'merged_id', p_merged_id,
    'updated_rows', v_total_updates,
    'tables_updated', v_updates
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_duplicate_candidate(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_candidate(uuid, uuid, uuid) TO service_role;
