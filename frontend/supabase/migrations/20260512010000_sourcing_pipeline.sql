-- New "sourcing" pipeline that lives in front of pitches / send_outs.
-- Tracks a candidate's journey for a specific job from first save
-- (uncontacted) through reply and back-of-resume. After that the user
-- promotes them into the existing pitch / send_out pipeline.
--
-- One row per (candidate_id, job_id). Stage transitions are auto-bumped
-- by triggers on messages / call_logs / meeting_attendees so that any
-- activity on any channel moves the candidate forward without manual
-- intervention.

CREATE TABLE IF NOT EXISTS public.sourcing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,

  stage TEXT NOT NULL DEFAULT 'uncontacted'
    CHECK (stage IN ('uncontacted', 'contacted', 'replied', 'back_of_resume')),

  -- LinkedIn provenance (populated when Save-to-Pipeline created the row)
  linkedin_project_id TEXT,
  linkedin_project_account_id TEXT,
  linkedin_pipeline_stage_id TEXT,

  -- Stage entry timestamps for funnel analytics
  uncontacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contacted_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  back_of_resume_at TIMESTAMPTZ,

  -- Withdrawn (same semantics as send_outs.withdrawn_*): hides the row
  -- from active stage views and prevents further auto-bumps.
  withdrawn_at TIMESTAMPTZ,
  withdrawn_reason TEXT,
  withdrawn_by UUID REFERENCES auth.users(id),

  -- Promoted (moved into the pitch / send_out pipeline after BoR).
  promoted_at TIMESTAMPTZ,
  promoted_to TEXT CHECK (promoted_to IN ('pitch', 'send_out') OR promoted_to IS NULL),
  promoted_to_id UUID,

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One sourcing record per candidate-job pair. Re-Save just updates.
  UNIQUE (candidate_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_sourcing_job_stage
  ON public.sourcing (job_id, stage)
  WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sourcing_candidate
  ON public.sourcing (candidate_id)
  WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sourcing_linkedin_project
  ON public.sourcing (linkedin_project_account_id, linkedin_project_id)
  WHERE linkedin_project_id IS NOT NULL;

-- ── Generic updated_at bookkeeping ────────────────────────────────
CREATE TRIGGER trg_sourcing_updated_at
  BEFORE UPDATE ON public.sourcing
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── RLS (mirrors the policy shape of pitches / send_outs) ────────
ALTER TABLE public.sourcing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sourcing_select_authenticated"
  ON public.sourcing FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "sourcing_insert_authenticated"
  ON public.sourcing FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "sourcing_update_authenticated"
  ON public.sourcing FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "sourcing_delete_authenticated"
  ON public.sourcing FOR DELETE
  TO authenticated
  USING (true);

-- ── Auto-transition: messages ────────────────────────────────────
-- Mirrors the trg_update_entity_comm_timestamps pattern (which already
-- fires for every inbound/outbound message regardless of platform).
-- The trigger only bumps forward — never downgrades a stage — and
-- ignores rows that have been withdrawn.
CREATE OR REPLACE FUNCTION public.fn_sourcing_bump_from_messages()
RETURNS TRIGGER AS $$
DECLARE
  cand_id UUID;
  evt_at TIMESTAMPTZ;
BEGIN
  cand_id := NEW.candidate_id;
  IF cand_id IS NULL AND NEW.conversation_id IS NOT NULL THEN
    SELECT candidate_id INTO cand_id
    FROM public.conversations
    WHERE id = NEW.conversation_id;
  END IF;
  IF cand_id IS NULL THEN
    RETURN NEW;
  END IF;

  evt_at := COALESCE(NEW.sent_at, NEW.created_at, now());

  IF NEW.direction = 'outbound' THEN
    UPDATE public.sourcing
       SET stage         = 'contacted',
           contacted_at  = COALESCE(contacted_at, evt_at)
     WHERE candidate_id = cand_id
       AND stage        = 'uncontacted'
       AND withdrawn_at IS NULL;
  ELSIF NEW.direction = 'inbound' THEN
    UPDATE public.sourcing
       SET stage        = 'replied',
           replied_at   = COALESCE(replied_at, evt_at),
           -- Backfill contacted_at when we go straight uncontacted→replied
           -- (rare but possible if the candidate reaches out first).
           contacted_at = COALESCE(contacted_at, evt_at)
     WHERE candidate_id = cand_id
       AND stage IN ('uncontacted', 'contacted')
       AND withdrawn_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sourcing_bump_from_messages ON public.messages;
CREATE TRIGGER trg_sourcing_bump_from_messages
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sourcing_bump_from_messages();

-- ── Auto-transition: call_logs → back_of_resume ──────────────────
-- A call linked to a candidate is the "on a call with them" signal.
-- Fires on INSERT and on linked_entity_id UPDATE so retroactive
-- phone-number → candidate matching also bumps the sourcing row.
CREATE OR REPLACE FUNCTION public.fn_sourcing_bump_from_calls()
RETURNS TRIGGER AS $$
DECLARE
  evt_at TIMESTAMPTZ;
BEGIN
  IF NEW.linked_entity_type <> 'candidate' OR NEW.linked_entity_id IS NULL THEN
    RETURN NEW;
  END IF;

  evt_at := COALESCE(NEW.started_at, NEW.created_at, now());

  UPDATE public.sourcing
     SET stage              = 'back_of_resume',
         back_of_resume_at  = COALESCE(back_of_resume_at, evt_at),
         contacted_at       = COALESCE(contacted_at, evt_at),
         replied_at         = COALESCE(replied_at, evt_at)
   WHERE candidate_id = NEW.linked_entity_id
     AND stage <> 'back_of_resume'
     AND withdrawn_at IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sourcing_bump_from_calls ON public.call_logs;
CREATE TRIGGER trg_sourcing_bump_from_calls
  AFTER INSERT OR UPDATE OF linked_entity_id, linked_entity_type
  ON public.call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sourcing_bump_from_calls();

-- ── Auto-transition: meetings → back_of_resume ───────────────────
-- meeting_attendees rows are inserted when a calendar event is linked
-- to a candidate (Outlook sync or manual). The actual event lives on
-- tasks where task_type='meeting'.
CREATE OR REPLACE FUNCTION public.fn_sourcing_bump_from_meetings()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entity_type <> 'candidate' OR NEW.entity_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.sourcing
     SET stage              = 'back_of_resume',
         back_of_resume_at  = COALESCE(back_of_resume_at, now()),
         contacted_at       = COALESCE(contacted_at, now()),
         replied_at         = COALESCE(replied_at, now())
   WHERE candidate_id = NEW.entity_id
     AND stage <> 'back_of_resume'
     AND withdrawn_at IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sourcing_bump_from_meetings ON public.meeting_attendees;
CREATE TRIGGER trg_sourcing_bump_from_meetings
  AFTER INSERT ON public.meeting_attendees
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sourcing_bump_from_meetings();

COMMENT ON TABLE public.sourcing IS
  'Pre-pitch funnel: tracks candidate stage (uncontacted/contacted/replied/back_of_resume) per (candidate, job). Auto-bumped by triggers on messages, call_logs, meeting_attendees.';
