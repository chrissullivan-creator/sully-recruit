-- Add owner_id column to candidates table for consistency with RLS policies
ALTER TABLE public.candidates 
ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Migrate existing user_id values to owner_id where user_id is not null
UPDATE public.candidates 
SET owner_id = user_id 
WHERE owner_id IS NULL AND user_id IS NOT NULL;

-- Make user_id nullable and add NOT NULL constraint to owner_id
ALTER TABLE public.candidates 
ALTER COLUMN user_id DROP NOT NULL,
ALTER COLUMN owner_id SET NOT NULL;

-- Create or replace trigger to auto-set owner_id and user_id on insert
CREATE OR REPLACE FUNCTION public.set_candidate_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    NEW.owner_id = auth.uid();
  END IF;
  -- Also set user_id to owner_id for backward compatibility
  IF NEW.user_id IS NULL THEN
    NEW.user_id = NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Apply trigger to candidates
DROP TRIGGER IF EXISTS set_candidates_owner ON public.candidates;
DROP TRIGGER IF EXISTS set_candidate_owner ON public.candidates;
CREATE TRIGGER set_candidate_owner
  BEFORE INSERT ON public.candidates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_candidate_owner();

-- Drop old RLS policies if they exist
DROP POLICY IF EXISTS "Users can CRUD own candidates" ON public.candidates;
DROP POLICY IF EXISTS "Users manage own candidates" ON public.candidates;
DROP POLICY IF EXISTS "Users read all candidates" ON public.candidates;

-- Update RLS policies to use owner_id
CREATE POLICY "Users manage own candidates"
  ON public.candidates FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users read all candidates"
  ON public.candidates FOR SELECT TO authenticated
  USING (true);
