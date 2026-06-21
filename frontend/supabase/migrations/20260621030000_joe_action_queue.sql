-- Phase 3 of the AI-native roadmap (foundation): joe_action_queue — one
-- approvable "agent inbox" where both proactive briefing items and Joe's
-- agentic proposals can land for batch review. Additive + owner-RLS; nothing
-- writes to it until the proactive/agentic features are switched on.
CREATE TABLE IF NOT EXISTS joe_action_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('briefing','joe_proposal')),
  action_type     text NOT NULL CHECK (action_type IN
                    ('draft_message','enroll_in_sequence','move_pipeline_stage',
                     'create_task','add_note','review')),
  entity_type     text,
  entity_id       uuid,
  title           text NOT NULL,
  preview         text,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  route           text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','approved','done','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

ALTER TABLE joe_action_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own action queue"
  ON joe_action_queue FOR ALL TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_joe_action_queue_owner
  ON joe_action_queue (owner_user_id, status, created_at DESC);
