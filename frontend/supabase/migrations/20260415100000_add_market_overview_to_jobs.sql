-- Add market_overview column to jobs table
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS market_overview TEXT;
