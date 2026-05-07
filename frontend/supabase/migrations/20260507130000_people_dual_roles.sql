-- Multi-role support: a person can be both a candidate AND a client
-- (e.g. someone you placed years ago who's now a hiring manager).
--
-- Rather than blow up `type` (lots of code reads it as the primary
-- role label), we ADD a roles[] array. `type` keeps its meaning as
-- "primary role for default display" — `roles` is the truth for
-- matching, filtering, and badges.
--
-- Backfill: every existing row's roles[] starts with its current type.

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS roles TEXT[];

UPDATE public.people
SET roles = ARRAY[type]
WHERE (roles IS NULL OR cardinality(roles) = 0)
  AND type IN ('candidate', 'client');

ALTER TABLE public.people
  ALTER COLUMN roles SET NOT NULL,
  ALTER COLUMN roles SET DEFAULT ARRAY['candidate']::TEXT[];

ALTER TABLE public.people
  DROP CONSTRAINT IF EXISTS people_roles_valid;
ALTER TABLE public.people
  ADD CONSTRAINT people_roles_valid CHECK (
    cardinality(roles) >= 1
    AND roles <@ ARRAY['candidate', 'client']::TEXT[]
  );

-- Fast filter for "show me everyone who is X" — array operators use
-- the GIN index automatically.
CREATE INDEX IF NOT EXISTS idx_people_roles_gin
  ON public.people USING GIN (roles);

-- Helper: keep `type` in sync with roles so legacy code that reads
-- the singular column stays sane.
--   - If a person is BOTH, type = 'candidate' (matches the historical
--     bias — they're more likely to be searched as a candidate).
--   - Otherwise type follows the single role in the array.
CREATE OR REPLACE FUNCTION public.sync_people_type_with_roles()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.roles IS NOT NULL AND cardinality(NEW.roles) >= 1 THEN
    IF 'candidate' = ANY(NEW.roles) THEN
      NEW.type := 'candidate';
    ELSIF 'client' = ANY(NEW.roles) THEN
      NEW.type := 'client';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_sync_type ON public.people;
CREATE TRIGGER people_sync_type
  BEFORE INSERT OR UPDATE OF roles ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.sync_people_type_with_roles();
