-- Communication Hub rework: indexes supporting per-user scoping.
--
-- Calls are now scoped by call_logs.owner_id (the inbox + Calls panel filter
-- to the current user, with an admin Team toggle). Add an index so that filter
-- is cheap. Threads are scoped by integration_account_id, which already has an
-- index (idx_conversations_integration_account_id).

CREATE INDEX IF NOT EXISTS idx_call_logs_owner_id
  ON public.call_logs (owner_id);
