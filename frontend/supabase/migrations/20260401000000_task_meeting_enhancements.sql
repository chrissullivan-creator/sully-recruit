-- Phase 2: Extend tasks for meeting support + new task fields
-- Phase 4: Candidate work history & education
-- Phase 6: Message templates
-- Phase 7: Sequence templates
-- Phase 9: Sequence analytics tracking fields

-- ══════════════════════════════════════════════════════════════
-- TASKS / MEETINGS
-- ══════════════════════════════════════════════════════════════

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_time timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_time timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS meeting_url text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS meeting_provider text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS related_to_type text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS related_to_id uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS no_calendar_invites boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS create_followup boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_subtype text;

CREATE TABLE IF NOT EXISTS task_collaborators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE task_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_attendees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users manage task_collaborators"
  ON task_collaborators FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users manage meeting_attendees"
  ON meeting_attendees FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- CANDIDATE WORK HISTORY & EDUCATION
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS candidate_work_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  title text,
  start_date date,
  end_date date,
  is_current boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidate_education (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  institution text NOT NULL,
  degree text,
  field_of_study text,
  start_year integer,
  end_year integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE candidate_work_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_education ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users manage candidate_work_history"
  ON candidate_work_history FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users manage candidate_education"
  ON candidate_education FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- MESSAGE TEMPLATES
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text,
  body text NOT NULL,
  channel text,
  category text,
  created_by uuid,
  is_shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users manage message_templates"
  ON message_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- SEQUENCE TEMPLATES
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sequence_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  channel text,
  stop_on_reply boolean NOT NULL DEFAULT true,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  is_shared boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sequence_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users manage sequence_templates"
  ON sequence_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- SEQUENCE ANALYTICS TRACKING
-- ══════════════════════════════════════════════════════════════

ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0;
ALTER TABLE sequence_step_executions ADD COLUMN IF NOT EXISTS replied_at timestamptz;
