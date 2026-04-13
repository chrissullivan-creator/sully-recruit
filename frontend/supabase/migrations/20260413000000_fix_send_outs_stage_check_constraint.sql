-- Fix send_outs_stage_check constraint to include all stage values used in the app
-- Previous constraint only allowed: send_out, submitted, interviewing, offer, placed, rejected, withdrawn
-- This caused "violates check constraint" errors when inserting with stage='lead' (the default)
ALTER TABLE public.send_outs DROP CONSTRAINT IF EXISTS send_outs_stage_check;
ALTER TABLE public.send_outs ADD CONSTRAINT send_outs_stage_check
  CHECK (stage = ANY (ARRAY[
    'lead', 'new', 'back_of_resume', 'reached_out', 'pitch',
    'send_out', 'sent', 'submitted',
    'interview', 'interviewing',
    'offer', 'placed', 'rejected', 'withdrew', 'withdrawn'
  ]));
