-- Dedupe resumes by (candidate_id, file_name).
--
-- Background: bulk-import flows and orphan-recovery were inserting the same
-- file under timestamped paths, so the existing (candidate_id, file_path)
-- dedup never matched. One candidate (Sthala Narasimhan) accumulated 11
-- copies of the same resume; another candidate ended up with 176.
--
-- Keep rule: parsing_status='completed' first, then rows with parsed_json,
-- then rows with raw_text, then the oldest created_at.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY candidate_id, file_name
      ORDER BY
        CASE WHEN parsing_status = 'completed' THEN 0 ELSE 1 END,
        CASE WHEN parsed_json IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN raw_text IS NOT NULL THEN 0 ELSE 1 END,
        created_at
    ) AS rn
  FROM resumes
  WHERE candidate_id IS NOT NULL AND file_name IS NOT NULL
)
DELETE FROM resumes
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS resumes_candidate_filename_unique
  ON resumes (candidate_id, file_name)
  WHERE candidate_id IS NOT NULL AND file_name IS NOT NULL;
