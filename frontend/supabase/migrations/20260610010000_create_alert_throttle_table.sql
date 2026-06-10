-- Durable throttle for notifyError() alert emails. The previous throttle was a
-- per-process in-memory Map, which resets on every Vercel serverless cold
-- start — so a recurring failure (e.g. poll-rc-calls erroring every 5 min)
-- emailed on nearly every run instead of once/hour. This table makes the
-- 1/hour-per-(taskId,signature) cap hold across invocations.
--
-- Already applied live via MCP (Supabase migration create_alert_throttle_table);
-- this file tracks it in the repo. Idempotent.
CREATE TABLE IF NOT EXISTS public.alert_throttle (
  cache_key text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);

-- Only the service role (used by notifyError via getSupabaseAdmin) touches
-- this; enable RLS with no policies so no client can read/write it.
ALTER TABLE public.alert_throttle ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.alert_throttle IS
  'Durable 1/hour throttle for notifyError() alert emails. cache_key = taskId:errorSignature.';
