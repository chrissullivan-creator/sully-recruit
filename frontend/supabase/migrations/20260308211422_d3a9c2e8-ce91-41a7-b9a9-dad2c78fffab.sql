ALTER TABLE public.sequence_steps 
  ADD COLUMN IF NOT EXISTS delay_hours integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_window_start integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS send_window_end integer NOT NULL DEFAULT 23,
  ADD COLUMN IF NOT EXISTS wait_for_connection boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_hours_after_connection integer NOT NULL DEFAULT 4;

ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS stop_on_reply boolean NOT NULL DEFAULT true;