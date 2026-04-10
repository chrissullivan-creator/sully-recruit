-- =============================================================
-- Send-out workflow: interviews, stage transitions, placements
-- Adds submittal fields to send_outs, creates interviews,
-- stage_transitions, and placements tables, and wires a trigger
-- to log stage changes on send_outs into stage_transitions.
-- =============================================================

-- 1. Extend send_outs with submittal metadata ------------------
ALTER TABLE public.send_outs
  ADD COLUMN IF NOT EXISTS submittal_notes TEXT,
  ADD COLUMN IF NOT EXISTS resume_link     TEXT;


-- 2. interviews ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.interviews (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  send_out_id             uuid        NOT NULL REFERENCES public.send_outs(id) ON DELETE CASCADE,
  round                   int         NOT NULL DEFAULT 1,
  type                    text        NOT NULL DEFAULT 'phone_screen',
  stage                   text,
  scheduled_at            timestamptz,
  timezone                text,
  location                text,
  meeting_link            text,
  primary_interviewer_id  uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  panel_members           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  calendar_event_id       text,
  outcome                 text        NOT NULL DEFAULT 'pending',
  completed_at            timestamptz,
  debrief_notes           text,
  ai_summary              text,
  ai_sentiment            text,
  ai_confidence           numeric,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interviews_send_out_id_idx       ON public.interviews(send_out_id);
CREATE INDEX IF NOT EXISTS interviews_scheduled_at_idx      ON public.interviews(scheduled_at);
CREATE INDEX IF NOT EXISTS interviews_primary_interviewer_idx ON public.interviews(primary_interviewer_id);

ALTER TABLE public.interviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access interviews" ON public.interviews;
CREATE POLICY "Authenticated full access interviews" ON public.interviews
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);


-- 3. stage_transitions -----------------------------------------
CREATE TABLE IF NOT EXISTS public.stage_transitions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text        NOT NULL,            -- 'send_out' | 'interview' | ...
  entity_id      uuid        NOT NULL,
  from_stage     text,
  to_stage       text        NOT NULL,
  moved_by_type  text        NOT NULL DEFAULT 'human',  -- 'human' | 'ai' | 'system'
  moved_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  source         text,                              -- 'board_drag' | 'drawer' | 'trigger' | 'edge_fn'
  ai_reasoning   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stage_transitions_entity_idx
  ON public.stage_transitions(entity_type, entity_id, created_at DESC);

ALTER TABLE public.stage_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read stage_transitions" ON public.stage_transitions;
CREATE POLICY "Authenticated read stage_transitions" ON public.stage_transitions
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated insert stage_transitions" ON public.stage_transitions;
CREATE POLICY "Authenticated insert stage_transitions" ON public.stage_transitions
  FOR INSERT TO authenticated
  WITH CHECK (true);


-- 4. placements ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.placements (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  send_out_id         uuid        NOT NULL UNIQUE REFERENCES public.send_outs(id) ON DELETE CASCADE,
  salary              numeric,
  fee_type            text        DEFAULT 'percent',  -- 'percent' | 'flat'
  fee_percent         numeric,
  fee_amount          numeric,
  invoice_status      text        DEFAULT 'pending',  -- 'pending' | 'sent' | 'paid' | 'overdue'
  invoice_date        date,
  invoice_number      text,
  payment_date        date,
  guarantee_days      int         DEFAULT 90,
  guarantee_end_date  date,
  falloff             boolean     NOT NULL DEFAULT false,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS placements_send_out_id_idx ON public.placements(send_out_id);

ALTER TABLE public.placements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access placements" ON public.placements;
CREATE POLICY "Authenticated full access placements" ON public.placements
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);


-- 5. updated_at triggers ---------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_interviews_touch ON public.interviews;
CREATE TRIGGER trg_interviews_touch
  BEFORE UPDATE ON public.interviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_placements_touch ON public.placements;
CREATE TRIGGER trg_placements_touch
  BEFORE UPDATE ON public.placements
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- 6. Auto-log send_out stage changes into stage_transitions ----
CREATE OR REPLACE FUNCTION public.log_sendout_stage_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.stage_transitions (entity_type, entity_id, from_stage, to_stage, moved_by_type, moved_by, source)
    VALUES ('send_out', NEW.id, NULL, NEW.stage, 'system', auth.uid(), 'insert');
  ELSIF TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage THEN
    INSERT INTO public.stage_transitions (entity_type, entity_id, from_stage, to_stage, moved_by_type, moved_by, source)
    VALUES ('send_out', NEW.id, OLD.stage, NEW.stage, 'human', auth.uid(), 'update');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_sendout_stage ON public.send_outs;
CREATE TRIGGER trg_log_sendout_stage
  AFTER INSERT OR UPDATE OF stage ON public.send_outs
  FOR EACH ROW
  EXECUTE FUNCTION public.log_sendout_stage_transition();


-- 7. Rebuild send_out_board view to expose candidate avatar/email
--    and recruiter name for the kanban cards.
DROP VIEW IF EXISTS public.send_out_board CASCADE;
CREATE VIEW public.send_out_board AS
SELECT
  s.id,
  s.candidate_id,
  s.contact_id,
  s.job_id,
  s.recruiter_id,
  s.stage,
  s.outcome,
  s.sent_to_client_at,
  s.interview_at,
  s.offer_at,
  s.placed_at,
  s.rejected_by,
  s.rejection_reason,
  s.feedback,
  s.submittal_notes,
  s.resume_link,
  s.created_at,
  s.updated_at,
  c.full_name  AS candidate_name,
  c.email      AS candidate_email,
  c.linkedin_url AS candidate_linkedin_url,
  NULL::text   AS candidate_avatar_url,
  j.title      AS job_title,
  co.name      AS company_name,
  ct.full_name AS contact_name,
  p.full_name  AS recruiter_name,
  p.avatar_url AS recruiter_avatar_url
FROM public.send_outs s
LEFT JOIN public.candidates c ON c.id = s.candidate_id
LEFT JOIN public.jobs       j ON j.id = s.job_id
LEFT JOIN public.companies  co ON co.id = j.company_id
LEFT JOIN public.contacts   ct ON ct.id = s.contact_id
LEFT JOIN public.profiles   p  ON p.id  = s.recruiter_id;

ALTER VIEW public.send_out_board SET (security_barrier = true);
