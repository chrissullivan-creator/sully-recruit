-- ============================================================================
-- V2 Sequence Engine Schema
-- ============================================================================
-- The v2 sequence scheduler uses a node/action model instead of the v1
-- flat step model. This migration adds the missing tables and columns that
-- the v2 code (sequence-scheduler.ts, send-time-calculator.ts, etc.) expects.
-- The v1 tables (sequence_steps, sequence_step_executions) are preserved
-- for backwards compatibility.
-- ============================================================================

-- ─── sequence_nodes ─────────────────────────────────────────────────────────
-- Each sequence has ordered nodes; each node holds one or more actions.
CREATE TABLE IF NOT EXISTS public.sequence_nodes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id UUID NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  node_order INTEGER NOT NULL DEFAULT 0,
  node_type TEXT NOT NULL DEFAULT 'action',
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── sequence_actions ───────────────────────────────────────────────────────
-- An action is a single send (email, sms, linkedin_message, etc.) within a node.
CREATE TABLE IF NOT EXISTS public.sequence_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  node_id UUID NOT NULL REFERENCES public.sequence_nodes(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  message_body TEXT,
  subject TEXT,
  base_delay_hours NUMERIC NOT NULL DEFAULT 0,
  delay_interval_minutes INTEGER NOT NULL DEFAULT 0,
  jiggle_minutes INTEGER NOT NULL DEFAULT 0,
  use_signature BOOLEAN NOT NULL DEFAULT false,
  post_connect_delay_hours NUMERIC NOT NULL DEFAULT 4,
  post_connect_jitter_min INTEGER NOT NULL DEFAULT 0,
  post_connect_jitter_max INTEGER NOT NULL DEFAULT 0,
  action_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── sequence_step_logs ─────────────────────────────────────────────────────
-- Tracks execution of each scheduled action per enrollment.
-- Replaces sequence_step_executions for v2 enrollments.
CREATE TABLE IF NOT EXISTS public.sequence_step_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID NOT NULL REFERENCES public.sequence_enrollments(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES public.sequence_actions(id) ON DELETE CASCADE,
  node_id UUID REFERENCES public.sequence_nodes(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled',
  skip_reason TEXT,
  reply_received_at TIMESTAMPTZ,
  reply_text TEXT,
  sentiment TEXT,
  sentiment_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── daily_send_log ─────────────────────────────────────────────────────────
-- Tracks how many messages each account sent per channel per day.
-- Used by send-time-calculator.ts for daily cap enforcement.
CREATE TABLE IF NOT EXISTS public.daily_send_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  send_date DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, channel, send_date)
);

-- ─── channel_limits ─────────────────────────────────────────────────────────
-- Per-channel daily and hourly send caps.
-- Used by send-time-calculator.ts for rate limiting.
CREATE TABLE IF NOT EXISTS public.channel_limits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL UNIQUE,
  daily_max INTEGER,
  hourly_max INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed sensible defaults for channel limits
INSERT INTO public.channel_limits (channel, daily_max, hourly_max)
VALUES
  ('email', 100, 8),
  ('sms', 50, 5),
  ('linkedin_connection', 40, 5),
  ('linkedin_message', 80, 10),
  ('linkedin_inmail', 25, 5)
ON CONFLICT (channel) DO NOTHING;

-- ─── Additional columns on sequences ────────────────────────────────────────
ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS send_window_start TEXT DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS send_window_end TEXT DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS audience_type TEXT DEFAULT 'candidates',
  ADD COLUMN IF NOT EXISTS objective TEXT;

-- ─── Additional columns on sequence_enrollments ─────────────────────────────
ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS current_node_id UUID REFERENCES public.sequence_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stop_trigger TEXT,
  ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ;

-- ─── Enable RLS ─────────────────────────────────────────────────────────────
ALTER TABLE public.sequence_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_step_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_limits ENABLE ROW LEVEL SECURITY;

-- ─── RLS Policies (team-wide access) ────────────────────────────────────────
CREATE POLICY "Authenticated full access sequence_nodes"
  ON public.sequence_nodes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access sequence_actions"
  ON public.sequence_actions FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access sequence_step_logs"
  ON public.sequence_step_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access daily_send_log"
  ON public.daily_send_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated full access channel_limits"
  ON public.channel_limits FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─── Indexes for common queries ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sequence_nodes_sequence_id
  ON public.sequence_nodes(sequence_id);

CREATE INDEX IF NOT EXISTS idx_sequence_actions_node_id
  ON public.sequence_actions(node_id);

CREATE INDEX IF NOT EXISTS idx_step_logs_enrollment_status
  ON public.sequence_step_logs(enrollment_id, status);

CREATE INDEX IF NOT EXISTS idx_step_logs_scheduled_at_status
  ON public.sequence_step_logs(scheduled_at, status)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_daily_send_log_lookup
  ON public.daily_send_log(account_id, channel, send_date);

-- ─── updated_at triggers ────────────────────────────────────────────────────
CREATE TRIGGER update_sequence_nodes_updated_at
  BEFORE UPDATE ON public.sequence_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sequence_actions_updated_at
  BEFORE UPDATE ON public.sequence_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sequence_step_logs_updated_at
  BEFORE UPDATE ON public.sequence_step_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_channel_limits_updated_at
  BEFORE UPDATE ON public.channel_limits
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
