-- Backfill integration_accounts.unipile_account_id_v2 from metadata.
--
-- The Unipile v2 Recruiter helpers (getUnipileAccountV2IdByV1Id /
-- getUnipileAccountV2IdForUser in src/server-lib/unipile-v2.ts) resolve the
-- canonical acc_xxx id from the top-level `unipile_account_id_v2` column, but
-- the LinkedIn connect flow (connect-linkedin*.ts) historically wrote it only
-- into metadata->>'unipile_account_id_v2'. That left rows (e.g. Nancy's
-- LinkedIn) with a NULL column but a populated metadata value, so create_project
-- / save_candidate returned 409 "No Unipile v2 account id" even though the
-- acc_xxx was known. Reconcile by copying metadata → column wherever the column
-- is null. Idempotent; safe to re-run (no-op once columns are populated).
UPDATE integration_accounts
SET unipile_account_id_v2 = metadata->>'unipile_account_id_v2'
WHERE unipile_account_id_v2 IS NULL
  AND metadata->>'unipile_account_id_v2' IS NOT NULL;
