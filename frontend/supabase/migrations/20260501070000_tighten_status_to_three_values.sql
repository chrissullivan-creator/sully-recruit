-- Per direction: candidates and clients share statuses: new | reached_out | engaged.
-- Existing candidates only use these three values (verified). Tighten the CHECK constraint.
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_status_check;
ALTER TABLE candidates ADD  CONSTRAINT candidates_status_check
  CHECK (status IN ('new', 'reached_out', 'engaged'));
