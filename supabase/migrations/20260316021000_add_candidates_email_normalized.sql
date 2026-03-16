-- Add normalized email support for deduplicated candidate imports
ALTER TABLE public.candidates
ADD COLUMN IF NOT EXISTS email_normalized TEXT;

CREATE OR REPLACE FUNCTION public.set_candidate_email_normalized()
RETURNS TRIGGER AS $$
BEGIN
  NEW.email_normalized := NULLIF(lower(btrim(NEW.email)), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS set_candidate_email_normalized ON public.candidates;
CREATE TRIGGER set_candidate_email_normalized
  BEFORE INSERT OR UPDATE OF email ON public.candidates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_candidate_email_normalized();

UPDATE public.candidates
SET email_normalized = NULLIF(lower(btrim(email)), '')
WHERE email_normalized IS DISTINCT FROM NULLIF(lower(btrim(email)), '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_email_normalized_unique
  ON public.candidates (email_normalized)
  WHERE email_normalized IS NOT NULL;
