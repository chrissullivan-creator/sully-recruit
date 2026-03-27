
-- Allow all authenticated users to read all integration accounts (for sender picker)
DROP POLICY IF EXISTS "Users manage own integration_accounts" ON public.integration_accounts;

-- Users can manage (insert/update/delete) their own accounts
CREATE POLICY "Users manage own integration_accounts"
  ON public.integration_accounts
  FOR ALL
  TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- All authenticated users can read all accounts (for sender selection)
CREATE POLICY "Users read all integration_accounts"
  ON public.integration_accounts
  FOR SELECT
  TO authenticated
  USING (true);
