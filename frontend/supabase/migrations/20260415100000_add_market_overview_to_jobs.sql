-- Add market_over boolean column to jobs table
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS market_over BOOLEAN NOT NULL DEFAULT false;
