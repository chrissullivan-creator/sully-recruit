-- Helpers for candidate import normalization
CREATE OR REPLACE FUNCTION public.normalize_import_text(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(COALESCE(p_value, ''), E'\\uFFFD', '', 'g'),
          E'\\x00',
          '',
          'g'
        ),
        '[[:cntrl:]]',
        '',
        'g'
      )
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.import_candidates_json(
  p_rows jsonb,
  p_conflict_key text DEFAULT 'email'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  IF p_conflict_key NOT IN ('email', 'id') THEN
    RAISE EXCEPTION 'p_conflict_key must be either email or id';
  END IF;

  IF p_conflict_key = 'email' THEN
    WITH parsed AS (
      SELECT
        ord,
        CASE WHEN (row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (row->>'id')::uuid END AS input_id,
        lower(public.normalize_import_text(row->>'email')) AS email_norm,
        public.normalize_import_text(COALESCE(row->>'first_name', split_part(COALESCE(row->>'full_name', ''), ' ', 1))) AS first_name,
        public.normalize_import_text(COALESCE(row->>'last_name', regexp_replace(COALESCE(row->>'full_name', ''), '^[^ ]+\\s*', ''))) AS last_name,
        public.normalize_import_text(row->>'phone') AS phone,
        public.normalize_import_text(row->>'current_title') AS current_title,
        public.normalize_import_text(row->>'current_company') AS current_company,
        public.normalize_import_text(row->>'linkedin_url') AS linkedin_url,
        public.normalize_import_text(row->>'source') AS source,
        CASE
          WHEN jsonb_typeof(row->'skills') = 'array' THEN ARRAY(
            SELECT public.normalize_import_text(value)
            FROM jsonb_array_elements_text(row->'skills') AS value
            WHERE public.normalize_import_text(value) IS NOT NULL
          )
          ELSE ARRAY[]::text[]
        END AS skills,
        public.normalize_import_text(row->>'notes') AS notes
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(row, ord)
    ),
    deduped AS (
      SELECT DISTINCT ON (email_norm)
        *
      FROM parsed
      WHERE email_norm IS NOT NULL
      ORDER BY email_norm, ord DESC
    ),
    updated_rows AS (
      UPDATE public.candidates c
      SET
        first_name = COALESCE(d.first_name, c.first_name),
        last_name = COALESCE(d.last_name, c.last_name),
        email = d.email_norm,
        phone = COALESCE(d.phone, c.phone),
        current_title = COALESCE(d.current_title, c.current_title),
        current_company = COALESCE(d.current_company, c.current_company),
        linkedin_url = COALESCE(d.linkedin_url, c.linkedin_url),
        source = COALESCE(d.source, c.source),
        skills = CASE WHEN cardinality(d.skills) > 0 THEN d.skills ELSE c.skills END,
        notes = COALESCE(d.notes, c.notes),
        updated_at = now()
      FROM deduped d
      WHERE c.owner_id = v_owner_id
        AND lower(c.email) = d.email_norm
      RETURNING c.id
    ),
    inserted_rows AS (
      INSERT INTO public.candidates (
        owner_id,
        user_id,
        first_name,
        last_name,
        email,
        phone,
        current_title,
        current_company,
        linkedin_url,
        source,
        skills,
        notes
      )
      SELECT
        v_owner_id,
        v_owner_id,
        COALESCE(d.first_name, 'Unknown'),
        COALESCE(d.last_name, 'Unknown'),
        d.email_norm,
        d.phone,
        COALESCE(d.current_title, ''),
        COALESCE(d.current_company, ''),
        d.linkedin_url,
        d.source,
        d.skills,
        d.notes
      FROM deduped d
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.candidates c
        WHERE c.owner_id = v_owner_id
          AND lower(c.email) = d.email_norm
      )
      RETURNING id
    )
    SELECT
      (SELECT COUNT(*) FROM inserted_rows),
      (SELECT COUNT(*) FROM updated_rows),
      GREATEST(jsonb_array_length(p_rows) - (SELECT COUNT(*) FROM deduped), 0)
    INTO v_inserted, v_updated, v_skipped;
  ELSE
    WITH parsed AS (
      SELECT
        ord,
        CASE WHEN (row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (row->>'id')::uuid END AS input_id,
        lower(public.normalize_import_text(row->>'email')) AS email_norm,
        public.normalize_import_text(COALESCE(row->>'first_name', split_part(COALESCE(row->>'full_name', ''), ' ', 1))) AS first_name,
        public.normalize_import_text(COALESCE(row->>'last_name', regexp_replace(COALESCE(row->>'full_name', ''), '^[^ ]+\\s*', ''))) AS last_name,
        public.normalize_import_text(row->>'phone') AS phone,
        public.normalize_import_text(row->>'current_title') AS current_title,
        public.normalize_import_text(row->>'current_company') AS current_company,
        public.normalize_import_text(row->>'linkedin_url') AS linkedin_url,
        public.normalize_import_text(row->>'source') AS source,
        CASE
          WHEN jsonb_typeof(row->'skills') = 'array' THEN ARRAY(
            SELECT public.normalize_import_text(value)
            FROM jsonb_array_elements_text(row->'skills') AS value
            WHERE public.normalize_import_text(value) IS NOT NULL
          )
          ELSE ARRAY[]::text[]
        END AS skills,
        public.normalize_import_text(row->>'notes') AS notes
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(row, ord)
      WHERE (row->>'id') IS NOT NULL
    ),
    deduped AS (
      SELECT DISTINCT ON (input_id)
        *
      FROM parsed
      WHERE input_id IS NOT NULL
      ORDER BY input_id, ord DESC
    ),
    updated_rows AS (
      UPDATE public.candidates c
      SET
        first_name = COALESCE(d.first_name, c.first_name),
        last_name = COALESCE(d.last_name, c.last_name),
        email = COALESCE(d.email_norm, c.email),
        phone = COALESCE(d.phone, c.phone),
        current_title = COALESCE(d.current_title, c.current_title),
        current_company = COALESCE(d.current_company, c.current_company),
        linkedin_url = COALESCE(d.linkedin_url, c.linkedin_url),
        source = COALESCE(d.source, c.source),
        skills = CASE WHEN cardinality(d.skills) > 0 THEN d.skills ELSE c.skills END,
        notes = COALESCE(d.notes, c.notes),
        updated_at = now()
      FROM deduped d
      WHERE c.owner_id = v_owner_id
        AND c.id = d.input_id
      RETURNING c.id
    )
    SELECT
      0,
      (SELECT COUNT(*) FROM updated_rows),
      GREATEST(jsonb_array_length(p_rows) - (SELECT COUNT(*) FROM deduped), 0)
    INTO v_inserted, v_updated, v_skipped;
  END IF;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped', v_skipped,
    'conflict_key', p_conflict_key
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_candidates_json(jsonb, text) TO authenticated;
