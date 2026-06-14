-- The sequences.engine column defaulted to 'trigger' (the dead Trigger.dev
-- path). The live runner is Inngest, and sequence-sweep filters
-- engine='inngest' — so every sequence built in the UI was born on the wrong
-- engine and silently never fired. (June Check In BD was the casualty.)
--
-- Flip the default to 'inngest' so new sequences fire, and migrate any
-- remaining 'trigger' stragglers (same effect as admin/cutover-finalize).
ALTER TABLE sequences ALTER COLUMN engine SET DEFAULT 'inngest';
UPDATE sequences SET engine = 'inngest' WHERE engine = 'trigger';
