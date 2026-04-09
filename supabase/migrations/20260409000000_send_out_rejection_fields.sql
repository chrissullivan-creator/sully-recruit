-- Add rejection detail columns to send_outs table
ALTER TABLE public.send_outs
  ADD COLUMN IF NOT EXISTS rejected_by TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS feedback TEXT;
