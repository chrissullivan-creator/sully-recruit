-- Ensure enrollment identity is validated at recipient-level (not channel-level)
ALTER TABLE public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_active_recipient_required;

ALTER TABLE public.sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_active_recipient_required
  CHECK (
    status <> 'active'
    OR candidate_id IS NOT NULL
    OR contact_id IS NOT NULL
    OR prospect_id IS NOT NULL
  );

-- Audit existing active enrollments with contact_id NULL.
-- Keep rows that still have candidate_id/prospect_id; fail only rows with no recipient identity.
UPDATE public.sequence_enrollments
SET
  status = 'failed',
  stopped_reason = COALESCE(stopped_reason, 'missing_recipient_identity'),
  completed_at = COALESCE(completed_at, now()),
  updated_at = now()
WHERE status = 'active'
  AND contact_id IS NULL
  AND candidate_id IS NULL
  AND prospect_id IS NULL;
