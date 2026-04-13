-- Fix candidates_job_status_check constraint to include all job_status values used in the app
-- Previous constraint was missing: lead, back_of_resume, pitch, sent, interview
ALTER TABLE public.candidates DROP CONSTRAINT IF EXISTS candidates_job_status_check;
ALTER TABLE public.candidates ADD CONSTRAINT candidates_job_status_check
  CHECK (job_status IS NULL OR job_status = ANY (ARRAY[
    'lead', 'new', 'back_of_resume', 'reached_out', 'pitched', 'pitch',
    'send_out', 'sent', 'submitted',
    'interview', 'interviewing',
    'offer', 'placed', 'rejected', 'withdrew', 'withdrawn'
  ]));
