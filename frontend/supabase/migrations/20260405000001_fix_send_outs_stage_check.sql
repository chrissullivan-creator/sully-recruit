-- Fix send_outs_stage_check constraint to include all valid stage values
ALTER TABLE public.send_outs DROP CONSTRAINT IF EXISTS send_outs_stage_check;
ALTER TABLE public.send_outs ADD CONSTRAINT send_outs_stage_check
  CHECK (stage IN ('lead', 'new', 'reached_out', 'pitch', 'send_out', 'sent', 'submitted', 'interview', 'interviewing', 'offer', 'placed', 'rejected', 'withdrawn'));
