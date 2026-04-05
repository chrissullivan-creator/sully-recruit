-- ============================================================================
-- Add admin role: admins can edit any record regardless of ownership
-- ============================================================================

-- 1. Add is_admin column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- 2. Set Chris as admin (by email)
UPDATE public.profiles SET is_admin = true
WHERE email ILIKE '%chris.sullivan%' OR email ILIKE '%chrissullivan%';

-- 3. Helper function: returns true if the current user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_admin FROM public.profiles WHERE id = auth.uid()),
    false
  );
$$;

-- ============================================================================
-- 4. Update RLS policies on owner-scoped tables to allow admin bypass
-- ============================================================================

-- candidates: owner OR admin can write
DROP POLICY IF EXISTS "Users manage own candidates" ON public.candidates;
CREATE POLICY "Users manage own candidates"
  ON public.candidates FOR ALL TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

-- contacts: owner OR admin can write
DROP POLICY IF EXISTS "Users manage own contacts" ON public.contacts;
CREATE POLICY "Users manage own contacts"
  ON public.contacts FOR ALL TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

-- sequences: creator OR admin can write
DROP POLICY IF EXISTS "Users manage own sequences" ON public.sequences;
CREATE POLICY "Users manage own sequences"
  ON public.sequences FOR ALL TO authenticated
  USING (created_by = auth.uid() OR public.is_admin())
  WITH CHECK (created_by = auth.uid() OR public.is_admin());

-- sequence_enrollments: enrolled_by OR admin can write
DROP POLICY IF EXISTS "Users manage own enrollments" ON public.sequence_enrollments;
CREATE POLICY "Users manage own enrollments"
  ON public.sequence_enrollments FOR ALL TO authenticated
  USING (enrolled_by = auth.uid() OR public.is_admin())
  WITH CHECK (enrolled_by = auth.uid() OR public.is_admin());

-- send_outs: recruiter OR admin can write
DROP POLICY IF EXISTS "Users manage own send_outs" ON public.send_outs;
CREATE POLICY "Users manage own send_outs"
  ON public.send_outs FOR ALL TO authenticated
  USING (recruiter_id = auth.uid() OR public.is_admin())
  WITH CHECK (recruiter_id = auth.uid() OR public.is_admin());

-- call_logs: owner OR admin can write
DROP POLICY IF EXISTS "Users manage own call_logs" ON public.call_logs;
CREATE POLICY "Users manage own call_logs"
  ON public.call_logs FOR ALL TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

-- integration_accounts: owner OR admin can write
DROP POLICY IF EXISTS "Users manage own integration_accounts" ON public.integration_accounts;
CREATE POLICY "Users manage own integration_accounts"
  ON public.integration_accounts FOR ALL TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_user_id = auth.uid() OR public.is_admin());

-- tasks: creator/assignee OR admin can write
DROP POLICY IF EXISTS "Users manage own tasks" ON public.tasks;
CREATE POLICY "Users manage own tasks"
  ON public.tasks FOR ALL TO authenticated
  USING (created_by = auth.uid() OR assigned_to = auth.uid() OR public.is_admin())
  WITH CHECK (created_by = auth.uid() OR public.is_admin());

-- user_integrations: owner OR admin can manage
DROP POLICY IF EXISTS "Users can manage own integrations" ON public.user_integrations;
CREATE POLICY "Users can manage own integrations"
  ON public.user_integrations FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());
