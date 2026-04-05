-- Fix channel types: InMail and LinkedIn Message are completely different workflows.
-- InMails go through Unipile with message_type=INMAIL, no connection needed.
-- LinkedIn Messages require prior connection.

-- 1. Drop the old constraint (if it exists — may not on all envs)
DO $$
BEGIN
  ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_channel_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

-- 2. Add new constraint with all valid channel types
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_channel_check
  CHECK (channel IN (
    'sales_nav_inmail',
    'recruiter_inmail',
    'linkedin_message',
    'linkedin_connection',
    'email',
    'sms',
    'phone',
    -- Legacy values kept for backwards compat during transition
    'linkedin',
    'linkedin_recruiter',
    'sales_nav'
  ) OR channel IS NULL);

-- 3. Migrate existing data: route linkedin steps by account to correct channel type
-- Chris's Sales Nav account
UPDATE sequence_steps
SET channel = 'sales_nav_inmail', step_type = 'sales_nav_inmail'
WHERE channel IN ('linkedin', 'linkedin_recruiter', 'sales_nav')
  AND step_type IN ('linkedin_inmail', 'sales_nav_inmail')
  AND account_id IN (
    SELECT id FROM integration_accounts
    WHERE account_type = 'sales_navigator'
      OR unipile_account_id = '1Ti3bx-8RrC0B91qxp_9ww'
  );

-- Nancy's Recruiter account
UPDATE sequence_steps
SET channel = 'recruiter_inmail', step_type = 'recruiter_inmail'
WHERE channel IN ('linkedin', 'linkedin_recruiter', 'sales_nav')
  AND step_type IN ('linkedin_inmail', 'recruiter_inmail')
  AND account_id IN (
    SELECT id FROM integration_accounts
    WHERE account_type = 'linkedin_recruiter'
      OR unipile_account_id = 'ZsitoJXDQ8iSD6xGfpwj1A'
  );

-- Any remaining generic 'linkedin' channel steps that are classic messages
UPDATE sequence_steps
SET channel = 'linkedin_message', step_type = 'linkedin_message'
WHERE channel = 'linkedin'
  AND step_type IN ('linkedin_message', 'classic_message')
  AND channel != 'linkedin_connection';

-- Connection requests stay as-is (already linkedin_connection)
