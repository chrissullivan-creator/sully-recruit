-- Phase 1 of the AI-native roadmap: Proactive Joe (read-only briefings +
-- next-best-action). Purely additive and gated behind JOE_PROACTIVE_ENABLED
-- (seeded false), so nothing changes in production until the flag is flipped.

-- ── people: per-person "next best action" (computed by generate-joe-says) ──
ALTER TABLE people ADD COLUMN IF NOT EXISTS next_action text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS next_action_updated_at timestamptz;

-- ── joe_briefings: per-recruiter daily "Today / For You" feed ───────────────
CREATE TABLE IF NOT EXISTS joe_briefings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL,
  brief_date      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  entity_type     text NOT NULL CHECK (entity_type IN ('candidate','client','job')),
  entity_id       uuid NOT NULL,
  category        text NOT NULL CHECK (category IN
                    ('hot_lead','going_cold','stalled','reply_waiting','ops_warning')),
  headline        text NOT NULL,
  rationale       text,
  score           int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN
                    ('open','done','dismissed','snoozed')),
  snoozed_until   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One row per recruiter / entity / category / day so the cron can upsert
  -- idempotently across re-runs in the same morning.
  UNIQUE (owner_user_id, brief_date, entity_type, entity_id, category)
);

ALTER TABLE joe_briefings ENABLE ROW LEVEL SECURITY;

-- Recruiters see and act on their own briefing rows; the service role (cron)
-- writes them.
CREATE POLICY "Users read own briefings"
  ON joe_briefings FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid());
CREATE POLICY "Users update own briefings"
  ON joe_briefings FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_joe_briefings_owner_feed
  ON joe_briefings (owner_user_id, brief_date DESC, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_joe_briefings_entity
  ON joe_briefings (entity_type, entity_id);

-- ── feature flag (default OFF) ─────────────────────────────────────────────
INSERT INTO app_settings (key, value, description)
VALUES ('JOE_PROACTIVE_ENABLED', 'false',
        'Phase 1 proactive Joe: daily briefings + next-best-action. OFF by default.')
ON CONFLICT (key) DO NOTHING;
