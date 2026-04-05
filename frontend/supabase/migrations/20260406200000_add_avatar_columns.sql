-- Add avatar/profile picture URL columns to candidates, contacts, and companies
-- These store the LinkedIn profile picture URL from Unipile

ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_headline TEXT;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS logo_url TEXT;
