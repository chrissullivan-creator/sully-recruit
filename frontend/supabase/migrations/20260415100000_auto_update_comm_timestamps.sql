-- ============================================================================
-- Auto-update last_contacted_at / last_responded_at on message insert
-- ============================================================================
-- Ensures candidate and contact communication timestamps stay in sync
-- without relying solely on webhook handlers or manual sync tasks.

-- Ensure the columns exist on candidates (they may have been added ad-hoc)
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_spoken_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_comm_channel TEXT;

-- Ensure the columns exist on contacts
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_comm_channel TEXT;

-- ─── Trigger function ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_entity_comm_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  -- Update candidate timestamps
  IF NEW.candidate_id IS NOT NULL THEN
    IF NEW.direction = 'outbound' THEN
      UPDATE public.candidates SET
        last_contacted_at = GREATEST(last_contacted_at, COALESCE(NEW.sent_at, NEW.created_at)),
        last_comm_channel  = COALESCE(NEW.channel, last_comm_channel)
      WHERE id = NEW.candidate_id;
    ELSIF NEW.direction = 'inbound' THEN
      UPDATE public.candidates SET
        last_responded_at = GREATEST(last_responded_at, COALESCE(NEW.sent_at, NEW.created_at)),
        last_comm_channel  = COALESCE(NEW.channel, last_comm_channel)
      WHERE id = NEW.candidate_id;
    END IF;
  END IF;

  -- Update contact timestamps
  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.direction = 'outbound' THEN
      UPDATE public.contacts SET
        last_contacted_at   = GREATEST(last_contacted_at, COALESCE(NEW.sent_at, NEW.created_at)),
        last_reached_out_at = GREATEST(last_reached_out_at, COALESCE(NEW.sent_at, NEW.created_at)),
        last_comm_channel   = COALESCE(NEW.channel, last_comm_channel)
      WHERE id = NEW.contact_id;
    ELSIF NEW.direction = 'inbound' THEN
      UPDATE public.contacts SET
        last_responded_at = GREATEST(last_responded_at, COALESCE(NEW.sent_at, NEW.created_at)),
        last_comm_channel  = COALESCE(NEW.channel, last_comm_channel)
      WHERE id = NEW.contact_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Attach trigger to messages table ─────────────────────────────────────
DROP TRIGGER IF EXISTS trg_update_entity_comm_timestamps ON public.messages;
CREATE TRIGGER trg_update_entity_comm_timestamps
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_entity_comm_timestamps();
