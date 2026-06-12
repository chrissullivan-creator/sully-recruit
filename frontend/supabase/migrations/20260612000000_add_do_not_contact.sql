-- Compliance suppression flag.
--
-- When an inbound reply is classified `do_not_contact`, intel-extraction sets
-- this on the person. The sequence engine then refuses to enroll them and
-- stops any in-flight enrollment, so we never message them again regardless of
-- which sequence they land in. Lives on the base `people` table; the engine
-- reads/writes it directly (the candidates/contacts views don't need it for
-- enforcement). Surface it on the views in a later migration if the UI needs
-- to display/filter it.
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;

-- Partial index — the engine only ever filters for the suppressed minority.
CREATE INDEX IF NOT EXISTS idx_people_do_not_contact
  ON public.people (id)
  WHERE do_not_contact = true;
