-- Reclassify LinkedIn conversations from Recruiter accounts.
-- The backfill was storing all LinkedIn messages as channel='linkedin' because
-- Unipile folder/content_type metadata was unreliable. Now we also check the
-- integration account's account_type, and retroactively fix existing data.

-- 1. Expand the channel check constraint to allow linkedin_recruiter and linkedin_sales_nav
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav', 'email', 'sms'));

-- 2. Reclassify conversations from Recruiter accounts
UPDATE conversations
SET channel = 'linkedin_recruiter'
WHERE channel = 'linkedin'
  AND integration_account_id IN (
    SELECT id FROM integration_accounts WHERE account_type = 'linkedin_recruiter'
  );
