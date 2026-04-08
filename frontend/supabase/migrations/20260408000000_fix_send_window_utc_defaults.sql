-- Fix send window defaults: values should be UTC hours, not EST.
-- Old defaults (6, 23) were EST-intended but interpreted as UTC by the runtime,
-- causing emails to fire as early as 1-2 AM Eastern.
-- Correct values: 10 (6 AM EDT) to 22 (6 PM EDT).

ALTER TABLE sequence_steps ALTER COLUMN send_window_start SET DEFAULT 10;
ALTER TABLE sequence_steps ALTER COLUMN send_window_end SET DEFAULT 22;

-- Update existing rows that still have the old incorrect defaults
UPDATE sequence_steps SET send_window_start = 10 WHERE send_window_start = 6;
UPDATE sequence_steps SET send_window_end = 22 WHERE send_window_end = 23;
