-- The sync_candidate_job_status trigger on send_outs blindly copies
-- send_outs.stage into candidates.job_status (via the people view).
-- send_outs.stage permits more values than candidates_job_status_check
-- — most importantly 'ready_to_send', which is the canonical key the
-- frontend uses when moving Pitch → Send Out. The mismatch surfaces
-- as:
--   new row for relation "people" violates check constraint
--   "candidates_job_status_check"
-- and blocks any stage move into "ready_to_send" (and a handful of
-- other valid send_outs stages).
--
-- Widen candidates_job_status_check to be a strict superset of
-- send_outs_stage_check so the trigger can never produce an invalid
-- value. Same shape as send_outs.stage plus the legacy 'back_of_resume'
-- value that older candidates rows still carry.

ALTER TABLE public.people
  DROP CONSTRAINT IF EXISTS candidates_job_status_check;

ALTER TABLE public.people
  ADD CONSTRAINT candidates_job_status_check
  CHECK (
    job_status IS NULL OR job_status = ANY (ARRAY[
      -- Funnel stages used by send_outs and candidate_jobs.
      'pitch', 'pitched',
      'ready_to_send', 'send_out', 'sendout',
      'submitted', 'sent',
      'interview', 'interviewing',
      'offer',
      'placed',
      'rejected', 'reject', 'declined',
      'withdrawn', 'withdrew',
      -- Pre-pipeline statuses still in use on people.
      'lead', 'new', 'back_of_resume', 'reached_out', 'engaged'
    ])
  );
