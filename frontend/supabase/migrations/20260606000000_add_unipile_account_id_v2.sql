-- Unipile v2 migration (LinkedIn Recruiter).
--
-- v2 (api.unipile.com/v2) addresses accounts by their canonical acc_xxx id
-- as a PATH segment, distinct from the short-form id used by the v1 DSN
-- (which we store in integration_accounts.unipile_account_id). Persist the
-- canonical id so v2 calls can address the account without a re-connection.
ALTER TABLE public.integration_accounts
  ADD COLUMN IF NOT EXISTS unipile_account_id_v2 text;

COMMENT ON COLUMN public.integration_accounts.unipile_account_id_v2 IS
  'Canonical Unipile v2 account id (acc_xxx), used as a PATH segment on api.unipile.com/v2. unipile_account_id holds the short-form id used by the v1 DSN.';

-- Feature flag: route LinkedIn Recruiter calls (projects / pipeline / search
-- / InMail) to Unipile v2. Default OFF — flip to 'true' only after the v2
-- Recruiter scope probe (/api/admin/probe-unipile-recruiter) returns 200 for
-- the v2 endpoints and unipile_account_id_v2 is populated.
INSERT INTO public.app_settings (key, value, description)
VALUES (
  'UNIPILE_LINKEDIN_V2',
  'false',
  'When true, LinkedIn Recruiter calls route to Unipile v2 (api.unipile.com/v2, acc_xxx path segment, UNIPILE_API_KEY_V2). Off = legacy v1 DSN behavior.'
)
ON CONFLICT (key) DO NOTHING;
