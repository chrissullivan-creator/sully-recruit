-- Send Out → Submission flow: extra submission facts on send_outs +
-- a scheduled_messages table backing the "schedule for later" Graph send.
-- Purely additive.

-- ── send_outs: total comp range + free-text additional notes ────────────────
ALTER TABLE send_outs
  ADD COLUMN IF NOT EXISTS total_comp_min numeric,
  ADD COLUMN IF NOT EXISTS total_comp_max numeric,
  ADD COLUMN IF NOT EXISTS additional_notes text,
  ADD COLUMN IF NOT EXISTS submission_email jsonb,
  ADD COLUMN IF NOT EXISTS offer_base numeric,
  ADD COLUMN IF NOT EXISTS offer_bonus numeric,
  ADD COLUMN IF NOT EXISTS offer_details text;

COMMENT ON COLUMN send_outs.offer_base IS 'Offer base salary, USD, recorded when moved to Offer';
COMMENT ON COLUMN send_outs.offer_bonus IS 'Offer bonus, USD, recorded at Offer';
COMMENT ON COLUMN send_outs.offer_details IS 'Free-text additional offer details (equity, sign-on, start date, etc.)';

COMMENT ON COLUMN send_outs.total_comp_min IS 'Total comp range low, USD, recorded at submission time (defaults to base+bonus when blank)';
COMMENT ON COLUMN send_outs.total_comp_max IS 'Total comp range high, USD, recorded at submission time';
COMMENT ON COLUMN send_outs.additional_notes IS 'Free-text submission notes the recruiter adds in the drawer; fed to the Ask-Joe email draft';
COMMENT ON COLUMN send_outs.submission_email IS 'Snapshot of the client submission email actually sent (or scheduled): {subject, body_html, to[], cc[], from, sent_at, scheduled_at, resume_file_name}';

-- ── scheduled_messages: queued Graph sends fired by an Inngest delayed event ─
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  candidate_id     uuid,
  job_id           uuid,
  send_out_id      uuid,
  to_emails        text[] NOT NULL DEFAULT '{}',
  cc_emails        text[] NOT NULL DEFAULT '{}',
  subject          text,
  body_html        text NOT NULL DEFAULT '',
  attachment_paths text[] NOT NULL DEFAULT '{}',
  scheduled_at     timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','sent','canceled','failed')),
  sent_at          timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Owners read / manage their own scheduled sends; the service role (Inngest)
-- reads and updates them when the timer fires.
CREATE POLICY "Users read own scheduled messages"
  ON scheduled_messages FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Users insert own scheduled messages"
  ON scheduled_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users update own scheduled messages"
  ON scheduled_messages FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_owner
  ON scheduled_messages (user_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages (status, scheduled_at);
