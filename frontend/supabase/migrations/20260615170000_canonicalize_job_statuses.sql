-- Canonicalize job pipeline statuses to exactly five values:
--   lead, hot, offer_made  → ACTIVE (still being worked)
--   filled, closed_lost     → CLOSED (terminal)
--
-- jobs.status is a single column, so a closed job (filled / closed_lost) is
-- never also "active" or "hot" — those are derived groupings, not flags. The
-- frontend source of truth is frontend/src/lib/jobStatus.ts; this migration
-- aligns the DB default + existing rows and enforces the set so legacy values
-- ('open', 'active', 'closed_won', 'on_hold', 'closed', 'lost', …) can't drift
-- back in.

-- Map the one legacy "won" value onto the new "filled".
UPDATE public.jobs SET status = 'filled' WHERE status = 'closed_won';

-- Everything else off the canonical list (incl. the old default 'open' and the
-- stray 'active' rows) collapses to 'lead' — the base active state.
UPDATE public.jobs SET status = 'lead'
  WHERE status IS NULL
     OR status NOT IN ('lead', 'hot', 'offer_made', 'filled', 'closed_lost');

ALTER TABLE public.jobs ALTER COLUMN status SET DEFAULT 'lead';

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('lead', 'hot', 'offer_made', 'filled', 'closed_lost'));
