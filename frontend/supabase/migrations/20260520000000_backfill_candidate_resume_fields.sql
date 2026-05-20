-- Backfill candidate contact + profile fields from already-parsed resume JSON.
--
-- 963 candidates had skills in resumes.parsed_json but never had them
-- written to people.skills; 272 same story for phone, 266 for email,
-- 309 for linkedin_url, etc. Two causes:
--   1. ResumeDropZone never wrote skills (frontend bug, fixed in the same
--      change as this migration).
--   2. Inngest ingestion ran but failed mid-update on some legacy rows.
-- This migration is non-destructive — it only fills NULL/empty fields.
--
-- Email classification mirrors src/lib/email-classifier.ts: known personal
-- domains and .edu addresses go to personal_email, everything else to
-- work_email. Both phone and mobile_phone get the same parsed value
-- (matches Inngest behaviour at resume-ingestion.ts:234-235).

DO $$
DECLARE
  personal_domains text[] := ARRAY[
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'aol.com','verizon.net','comcast.net','sbcglobal.net','msn.com',
    'live.com','me.com','mac.com','ymail.com','mail.com','protonmail.com',
    'gmx.com','fastmail.com','att.net','cox.net','charter.net',
    'optonline.net','earthlink.net','rocketmail.com','duck.com',
    'pm.me','proton.me'
  ];
BEGIN

-- Per-candidate latest parsed_json (the most recently parsed resume wins
-- when a candidate has multiple resumes). Materialize once so each field's
-- UPDATE doesn't re-scan resumes.
CREATE TEMP TABLE _latest_parsed ON COMMIT DROP AS
SELECT DISTINCT ON (r.candidate_id)
  r.candidate_id,
  r.parsed_json
FROM resumes r
WHERE r.parsed_json IS NOT NULL
  AND r.candidate_id IS NOT NULL
ORDER BY r.candidate_id, r.created_at DESC NULLS LAST;

CREATE INDEX ON _latest_parsed (candidate_id);

-- Phone: fill both phone and mobile_phone when missing.
UPDATE people p
SET phone = NULLIF(trim(lp.parsed_json->>'phone'), ''),
    mobile_phone = COALESCE(p.mobile_phone, NULLIF(trim(lp.parsed_json->>'phone'), '')),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.phone IS NULL OR p.phone = '')
  AND NULLIF(trim(lp.parsed_json->>'phone'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- Mobile_phone-only fill (for rows that already had phone set but not mobile).
UPDATE people p
SET mobile_phone = NULLIF(trim(lp.parsed_json->>'phone'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.mobile_phone IS NULL OR p.mobile_phone = '')
  AND NULLIF(trim(lp.parsed_json->>'phone'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- Email: classify the parsed address and write to personal_email or
-- work_email. Skip rows that already have any email set, so primary_email
-- (the COALESCE'd generated column) stays stable.
WITH candidates_email AS (
  SELECT
    p.id,
    lower(trim(lp.parsed_json->>'email')) AS email,
    lower(split_part(trim(lp.parsed_json->>'email'), '@', 2)) AS domain
  FROM people p
  JOIN _latest_parsed lp ON lp.candidate_id = p.id
  WHERE p.primary_email IS NULL
    AND p.deleted_at IS NULL
    AND lp.parsed_json->>'email' IS NOT NULL
    AND trim(lp.parsed_json->>'email') <> ''
    -- crude email-shape guard
    AND trim(lp.parsed_json->>'email') ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
)
UPDATE people p
SET personal_email = CASE
      WHEN ce.domain = ANY(personal_domains) OR ce.domain LIKE '%.edu' THEN ce.email
      ELSE p.personal_email
    END,
    work_email = CASE
      WHEN ce.domain = ANY(personal_domains) OR ce.domain LIKE '%.edu' THEN p.work_email
      ELSE ce.email
    END,
    updated_at = now()
FROM candidates_email ce
WHERE p.id = ce.id;

-- Skills: only fill when the candidate row's array is null or empty AND
-- the parsed JSON has a non-empty array of strings.
UPDATE people p
SET skills = ARRAY(
      SELECT trim(s)
      FROM jsonb_array_elements_text(lp.parsed_json->'skills') AS s
      WHERE s IS NOT NULL AND trim(s) <> ''
    ),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.skills IS NULL OR cardinality(p.skills) = 0)
  AND jsonb_typeof(lp.parsed_json->'skills') = 'array'
  AND jsonb_array_length(lp.parsed_json->'skills') > 0
  AND p.deleted_at IS NULL;

-- LinkedIn URL.
UPDATE people p
SET linkedin_url = NULLIF(trim(lp.parsed_json->>'linkedin_url'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.linkedin_url IS NULL OR p.linkedin_url = '')
  AND NULLIF(trim(lp.parsed_json->>'linkedin_url'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- Location.
UPDATE people p
SET location_text = NULLIF(trim(lp.parsed_json->>'location'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.location_text IS NULL OR p.location_text = '')
  AND NULLIF(trim(lp.parsed_json->>'location'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- Current title.
UPDATE people p
SET current_title = NULLIF(trim(lp.parsed_json->>'current_title'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.current_title IS NULL OR p.current_title = '')
  AND NULLIF(trim(lp.parsed_json->>'current_title'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- Current company.
UPDATE people p
SET current_company = NULLIF(trim(lp.parsed_json->>'current_company'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.current_company IS NULL OR p.current_company = '')
  AND NULLIF(trim(lp.parsed_json->>'current_company'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- First name / last name (rare, but covers stub rows from email forwarders
-- that never got a name).
UPDATE people p
SET first_name = NULLIF(trim(lp.parsed_json->>'first_name'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.first_name IS NULL OR p.first_name = '')
  AND NULLIF(trim(lp.parsed_json->>'first_name'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

UPDATE people p
SET last_name = NULLIF(trim(lp.parsed_json->>'last_name'), ''),
    updated_at = now()
FROM _latest_parsed lp
WHERE lp.candidate_id = p.id
  AND (p.last_name IS NULL OR p.last_name = '')
  AND NULLIF(trim(lp.parsed_json->>'last_name'), '') IS NOT NULL
  AND p.deleted_at IS NULL;

-- full_name rebuild for rows where it's null but we now have at least one name part.
UPDATE people p
SET full_name = trim(both ' ' from
                    coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
    updated_at = now()
WHERE (p.full_name IS NULL OR p.full_name = '')
  AND (coalesce(p.first_name, '') || coalesce(p.last_name, '')) <> ''
  AND p.deleted_at IS NULL;

END $$;
