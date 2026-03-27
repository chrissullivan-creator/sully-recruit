-- Rename offer_accepted/accepted → win, closed → lost
UPDATE jobs SET status = 'win' WHERE status IN ('offer_accepted', 'accepted');
UPDATE jobs SET status = 'lost' WHERE status = 'closed';

-- Drop old constraint if it exists and add updated one
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
-- Intentionally permissive: allow legacy values to coexist during migration
-- New valid values: open, warm, hot, interviewing, offer, win, lost, on_hold, declined
