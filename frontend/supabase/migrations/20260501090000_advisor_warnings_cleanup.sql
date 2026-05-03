-- Pass 6: clean up the 36 actionable advisor warnings.
--   * 2 SECURITY DEFINER views -> security_invoker
--   * 25 auth_rls_initplan policies -> wrap auth.X() in (select auth.X())
--   * 9 multiple_permissive_policies -> split SELECT (team-wide) from writes (own-scope)
-- Skipping: rls_policy_always_true (intentional internal CRM), pg_graphql_*_table_exposed,
-- extension_in_public, unused_index.

------------------------------------------------------------
-- 1. SECURITY DEFINER -> security_invoker on the 2 views
------------------------------------------------------------
ALTER VIEW public.contacts                  SET (security_invoker = true);
ALTER VIEW public.v_company_primary_domain  SET (security_invoker = true);

------------------------------------------------------------
-- 2a. Tables with overlapping read-all + own-scope policies:
--     consolidate into FOR SELECT (team-wide) + per-cmd own-scope writes.
------------------------------------------------------------

-- call_logs (owner_id)
DROP POLICY IF EXISTS "Users manage own call_logs" ON call_logs;
DROP POLICY IF EXISTS "Users read all call_logs"   ON call_logs;
CREATE POLICY "team can read call_logs"        ON call_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "users can insert own call_logs" ON call_logs FOR INSERT TO authenticated WITH CHECK (owner_id = (select auth.uid()));
CREATE POLICY "users can update own call_logs" ON call_logs FOR UPDATE TO authenticated USING (owner_id = (select auth.uid())) WITH CHECK (owner_id = (select auth.uid()));
CREATE POLICY "users can delete own call_logs" ON call_logs FOR DELETE TO authenticated USING (owner_id = (select auth.uid()));

-- conversations (owner_id) -- preserve "team can update" intent
DROP POLICY IF EXISTS "Team can read all conversations" ON conversations;
DROP POLICY IF EXISTS "Team can update conversations"   ON conversations;
DROP POLICY IF EXISTS "Users manage own conversations"  ON conversations;
CREATE POLICY "team can read conversations"        ON conversations FOR SELECT TO authenticated USING (true);
CREATE POLICY "team can update conversations"      ON conversations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "users can insert own conversations" ON conversations FOR INSERT TO authenticated WITH CHECK (owner_id = (select auth.uid()));
CREATE POLICY "users can delete own conversations" ON conversations FOR DELETE TO authenticated USING (owner_id = (select auth.uid()));

-- duplicate_candidates (no owner column -- single team-wide policy)
DROP POLICY IF EXISTS "Authenticated users can manage duplicates" ON duplicate_candidates;
DROP POLICY IF EXISTS "Authenticated users can read duplicates"   ON duplicate_candidates;
CREATE POLICY "authenticated all duplicate_candidates" ON duplicate_candidates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- integration_accounts (owner_user_id)
DROP POLICY IF EXISTS "Users manage own integration_accounts" ON integration_accounts;
DROP POLICY IF EXISTS "Users read all integration_accounts"   ON integration_accounts;
CREATE POLICY "team can read integration_accounts"        ON integration_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "users can insert own integration_accounts" ON integration_accounts FOR INSERT TO authenticated WITH CHECK (owner_user_id = (select auth.uid()));
CREATE POLICY "users can update own integration_accounts" ON integration_accounts FOR UPDATE TO authenticated USING (owner_user_id = (select auth.uid())) WITH CHECK (owner_user_id = (select auth.uid()));
CREATE POLICY "users can delete own integration_accounts" ON integration_accounts FOR DELETE TO authenticated USING (owner_user_id = (select auth.uid()));

-- messages (owner_id) -- preserve "team can insert" intent
DROP POLICY IF EXISTS "Team can read all messages" ON messages;
DROP POLICY IF EXISTS "Team can insert messages"   ON messages;
DROP POLICY IF EXISTS "Users manage own messages"  ON messages;
CREATE POLICY "team can read messages"        ON messages FOR SELECT TO authenticated USING (true);
CREATE POLICY "team can insert messages"      ON messages FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "users can update own messages" ON messages FOR UPDATE TO authenticated USING (owner_id = (select auth.uid())) WITH CHECK (owner_id = (select auth.uid()));
CREATE POLICY "users can delete own messages" ON messages FOR DELETE TO authenticated USING (owner_id = (select auth.uid()));

-- send_outs (recruiter_id is the owner)
DROP POLICY IF EXISTS "Users manage own send_outs" ON send_outs;
DROP POLICY IF EXISTS "Users read all send_outs"   ON send_outs;
CREATE POLICY "team can read send_outs"        ON send_outs FOR SELECT TO authenticated USING (true);
CREATE POLICY "users can insert own send_outs" ON send_outs FOR INSERT TO authenticated WITH CHECK (recruiter_id = (select auth.uid()));
CREATE POLICY "users can update own send_outs" ON send_outs FOR UPDATE TO authenticated USING (recruiter_id = (select auth.uid())) WITH CHECK (recruiter_id = (select auth.uid()));
CREATE POLICY "users can delete own send_outs" ON send_outs FOR DELETE TO authenticated USING (recruiter_id = (select auth.uid()));

-- tasks (created_by + assigned_to)
DROP POLICY IF EXISTS "Users manage own tasks" ON tasks;
DROP POLICY IF EXISTS "Users read all tasks"   ON tasks;
CREATE POLICY "team can read tasks"        ON tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "users can insert own tasks" ON tasks FOR INSERT TO authenticated WITH CHECK (created_by = (select auth.uid()));
CREATE POLICY "users can update own tasks" ON tasks FOR UPDATE TO authenticated USING ((created_by = (select auth.uid())) OR (assigned_to = (select auth.uid()))) WITH CHECK (created_by = (select auth.uid()));
CREATE POLICY "users can delete own tasks" ON tasks FOR DELETE TO authenticated USING (created_by = (select auth.uid()));

------------------------------------------------------------
-- 2b. auth_rls_initplan-only policies (no multi-permissive overlap):
--     drop + recreate with auth.X() wrapped in (select auth.X())
------------------------------------------------------------

-- candidates
DROP POLICY IF EXISTS "authenticated can delete candidates" ON candidates;
CREATE POLICY "authenticated can delete candidates" ON candidates FOR DELETE TO authenticated
  USING ((owner_user_id IS NULL) OR (owner_user_id = (select auth.uid())) OR (created_by_user_id = (select auth.uid())));

DROP POLICY IF EXISTS "authenticated can insert candidates to emerald recruit" ON candidates;
CREATE POLICY "authenticated can insert candidates to emerald recruit" ON candidates FOR INSERT TO authenticated
  WITH CHECK ((created_by_user_id = (select auth.uid())) AND (owner_user_id = '83a7b48d-0220-4407-a494-3d982a8446db'::uuid));

DROP POLICY IF EXISTS "authenticated can update own or emerald recruit candidates" ON candidates;
CREATE POLICY "authenticated can update own or emerald recruit candidates" ON candidates FOR UPDATE TO authenticated
  USING ((owner_user_id = (select auth.uid())) OR (owner_user_id = '83a7b48d-0220-4407-a494-3d982a8446db'::uuid))
  WITH CHECK ((owner_user_id = (select auth.uid())) OR (owner_user_id = '83a7b48d-0220-4407-a494-3d982a8446db'::uuid));

-- ai_runs
DROP POLICY IF EXISTS "Users can read own ai_runs" ON ai_runs;
CREATE POLICY "Users can read own ai_runs" ON ai_runs FOR SELECT TO authenticated USING (user_id = (select auth.uid()));

-- channel_limits
DROP POLICY IF EXISTS "Authenticated users can read channel_limits" ON channel_limits;
CREATE POLICY "Authenticated users can read channel_limits" ON channel_limits FOR SELECT
  USING ((select auth.role()) = 'authenticated');

-- daily_send_log
DROP POLICY IF EXISTS "Authenticated users can manage daily_send_log" ON daily_send_log;
CREATE POLICY "Authenticated users can manage daily_send_log" ON daily_send_log FOR ALL
  USING ((select auth.role()) = 'authenticated');

-- graph_subscriptions
DROP POLICY IF EXISTS "users own graph subscriptions" ON graph_subscriptions;
CREATE POLICY "users own graph subscriptions" ON graph_subscriptions FOR ALL
  USING ((select auth.uid()) = user_id);

-- notifications
DROP POLICY IF EXISTS "Users see own notifications"    ON notifications;
DROP POLICY IF EXISTS "Users manage own notifications" ON notifications;
CREATE POLICY "Users see own notifications"    ON notifications FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY "Users manage own notifications" ON notifications FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

-- oauth_states
DROP POLICY IF EXISTS "users own oauth states" ON oauth_states;
CREATE POLICY "users own oauth states" ON oauth_states FOR ALL USING ((select auth.uid()) = user_id);

-- profiles
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated
  USING (id = (select auth.uid())) WITH CHECK (id = (select auth.uid()));

-- sequences family
DROP POLICY IF EXISTS "Authenticated users can manage sequences"            ON sequences;
CREATE POLICY "Authenticated users can manage sequences"                    ON sequences            FOR ALL USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can manage sequence_nodes"       ON sequence_nodes;
CREATE POLICY "Authenticated users can manage sequence_nodes"               ON sequence_nodes       FOR ALL USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can manage sequence_actions"     ON sequence_actions;
CREATE POLICY "Authenticated users can manage sequence_actions"             ON sequence_actions     FOR ALL USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can manage sequence_branches"    ON sequence_branches;
CREATE POLICY "Authenticated users can manage sequence_branches"            ON sequence_branches    FOR ALL USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can manage sequence_enrollments" ON sequence_enrollments;
CREATE POLICY "Authenticated users can manage sequence_enrollments"         ON sequence_enrollments FOR ALL USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can manage sequence_step_logs"   ON sequence_step_logs;
CREATE POLICY "Authenticated users can manage sequence_step_logs"           ON sequence_step_logs   FOR ALL USING ((select auth.role()) = 'authenticated');

-- user_integrations
DROP POLICY IF EXISTS "Users can manage own integrations" ON user_integrations;
CREATE POLICY "Users can manage own integrations" ON user_integrations FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- user_oauth_tokens
DROP POLICY IF EXISTS "users own oauth tokens" ON user_oauth_tokens;
CREATE POLICY "users own oauth tokens" ON user_oauth_tokens FOR ALL USING ((select auth.uid()) = user_id);
