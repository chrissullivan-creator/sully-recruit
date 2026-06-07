-- Calendly-style self-scheduling.
--
-- Each recruiter owns one (or more) `scheduling_links` — a public booking
-- page addressed by a unique slug (e.g. /book/chris-sullivan). The link
-- points at the Outlook `integration_accounts` row whose calendar we read
-- (free/busy) and write (the booking event) against.
--
-- `scheduling_bookings` records each confirmed booking. The public
-- /api/schedule/book endpoint (service role, bypasses RLS) re-validates the
-- slot, creates the Outlook event via Microsoft Graph, then inserts a row
-- here so future slot computations subtract already-booked times even
-- before the calendar sync catches up.
--
-- RLS: owner-only for the signed-in recruiter. Public traffic flows through
-- the two service-role API endpoints, which bypass RLS entirely.

-- ─────────────────────────────────────────────────────────────────────────
-- scheduling_links
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduling_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The Outlook account whose calendar we read (free/busy) and write
  -- (the booking event) against.
  integration_account_id uuid REFERENCES public.integration_accounts(id) ON DELETE SET NULL,
  slug text UNIQUE NOT NULL,
  title text,
  duration_min integer NOT NULL DEFAULT 30,
  meeting_type text NOT NULL DEFAULT 'phone'
    CHECK (meeting_type IN ('phone', 'teams', 'in_person')),
  location text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  -- Per-weekday availability. Keys are lowercase day names; each value is a
  -- list of {start,end} windows in 24h local "HH:MM". Empty list = day off.
  working_hours jsonb NOT NULL DEFAULT '{
    "monday":    [{"start": "09:00", "end": "17:00"}],
    "tuesday":   [{"start": "09:00", "end": "17:00"}],
    "wednesday": [{"start": "09:00", "end": "17:00"}],
    "thursday":  [{"start": "09:00", "end": "17:00"}],
    "friday":    [{"start": "09:00", "end": "17:00"}],
    "saturday":  [],
    "sunday":    []
  }'::jsonb,
  buffer_min integer NOT NULL DEFAULT 0,
  min_notice_hours integer NOT NULL DEFAULT 12,
  max_days_out integer NOT NULL DEFAULT 21,
  -- Cap on confirmed bookings per local calendar day (null = unlimited).
  max_per_day integer,
  -- Cap the booking horizon to N business days / working days (null = use max_days_out).
  max_business_days integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduling_links_slug
  ON public.scheduling_links (slug);
CREATE INDEX IF NOT EXISTS idx_scheduling_links_owner
  ON public.scheduling_links (owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- scheduling_bookings
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduling_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.scheduling_links(id) ON DELETE CASCADE,
  -- Optional link back to the person who booked. The unified person model
  -- keeps candidates + clients in one table, but the inbox/thread surfaces
  -- still expose candidate_id / contact_id separately, so we keep both.
  candidate_id uuid,
  contact_id uuid,
  invitee_name text,
  invitee_email text,
  invitee_phone text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'canceled')),
  outlook_event_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduling_bookings_link
  ON public.scheduling_bookings (link_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_bookings_start
  ON public.scheduling_bookings (start_at);

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at trigger (reuses the shared helper other tables use)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_scheduling_links_updated_at ON public.scheduling_links;
CREATE TRIGGER trg_scheduling_links_updated_at
  BEFORE UPDATE ON public.scheduling_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — owner-only for authenticated users. Public booking traffic uses the
-- service-role API endpoints, which bypass RLS.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.scheduling_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduling_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner manage scheduling_links" ON public.scheduling_links;
CREATE POLICY "owner manage scheduling_links"
  ON public.scheduling_links FOR ALL
  TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- Bookings are scoped through their parent link's owner.
DROP POLICY IF EXISTS "owner read scheduling_bookings" ON public.scheduling_bookings;
CREATE POLICY "owner read scheduling_bookings"
  ON public.scheduling_bookings FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.scheduling_links l
      WHERE l.id = scheduling_bookings.link_id
        AND l.owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "owner write scheduling_bookings" ON public.scheduling_bookings;
CREATE POLICY "owner write scheduling_bookings"
  ON public.scheduling_bookings FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.scheduling_links l
      WHERE l.id = scheduling_bookings.link_id
        AND l.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scheduling_links l
      WHERE l.id = scheduling_bookings.link_id
        AND l.owner_user_id = auth.uid()
    )
  );
