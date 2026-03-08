
-- =====================================================
-- FIX: Replace all RESTRICTIVE-only policies with PERMISSIVE
-- and add missing RLS policies on unprotected tables
-- =====================================================

-- 1. DROP existing RESTRICTIVE policies
DROP POLICY IF EXISTS "authenticated full access candidate_channels" ON public.candidate_channels;
DROP POLICY IF EXISTS "authenticated full access contact_channels" ON public.contact_channels;
DROP POLICY IF EXISTS "authenticated full access contacts" ON public.contacts;
DROP POLICY IF EXISTS "authenticated full access conversations" ON public.conversations;
DROP POLICY IF EXISTS "authenticated full access messages" ON public.messages;
DROP POLICY IF EXISTS "authenticated full access notes" ON public.notes;
DROP POLICY IF EXISTS "authenticated full access send_outs" ON public.send_outs;
DROP POLICY IF EXISTS "authenticated full access sequences" ON public.sequences;
DROP POLICY IF EXISTS "authenticated full access sequence_steps" ON public.sequence_steps;
DROP POLICY IF EXISTS "authenticated full access sequence_enrollments" ON public.sequence_enrollments;
DROP POLICY IF EXISTS "authenticated full access sequence_step_executions" ON public.sequence_step_executions;
DROP POLICY IF EXISTS "authenticated full access integration_accounts" ON public.integration_accounts;

-- 2. Enable RLS on tables that may not have it yet
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- 3. PERMISSIVE policies for owner-scoped tables
-- candidates (owner_id)
CREATE POLICY "Users manage own candidates" ON public.candidates
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users read all candidates" ON public.candidates
  FOR SELECT TO authenticated
  USING (true);

-- prospects (owner_id)
CREATE POLICY "Users manage own prospects" ON public.prospects
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users read all prospects" ON public.prospects
  FOR SELECT TO authenticated
  USING (true);

-- contacts (owner_id)
CREATE POLICY "Users manage own contacts" ON public.contacts
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users read all contacts" ON public.contacts
  FOR SELECT TO authenticated
  USING (true);

-- 4. PERMISSIVE policies for shared/team tables
-- jobs (shared across team)
CREATE POLICY "Authenticated full access jobs" ON public.jobs
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- companies (shared across team)
CREATE POLICY "Authenticated full access companies" ON public.companies
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- sequences (created_by scoped writes, team reads)
CREATE POLICY "Users manage own sequences" ON public.sequences
  FOR ALL TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users read all sequences" ON public.sequences
  FOR SELECT TO authenticated
  USING (true);

-- sequence_steps (inherits from sequences, team access)
CREATE POLICY "Authenticated full access sequence_steps" ON public.sequence_steps
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- sequence_enrollments (enrolled_by scoped writes, team reads)
CREATE POLICY "Users manage own enrollments" ON public.sequence_enrollments
  FOR ALL TO authenticated
  USING (enrolled_by = auth.uid())
  WITH CHECK (enrolled_by = auth.uid());

CREATE POLICY "Users read all enrollments" ON public.sequence_enrollments
  FOR SELECT TO authenticated
  USING (true);

-- sequence_step_executions (team access)
CREATE POLICY "Authenticated full access sequence_step_executions" ON public.sequence_step_executions
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- send_outs (recruiter_id scoped writes, team reads)
CREATE POLICY "Users manage own send_outs" ON public.send_outs
  FOR ALL TO authenticated
  USING (recruiter_id = auth.uid())
  WITH CHECK (recruiter_id = auth.uid());

CREATE POLICY "Users read all send_outs" ON public.send_outs
  FOR SELECT TO authenticated
  USING (true);

-- messages (team access for CRM)
CREATE POLICY "Authenticated full access messages" ON public.messages
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- conversations (team access for CRM)
CREATE POLICY "Authenticated full access conversations" ON public.conversations
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- notes (team access)
CREATE POLICY "Authenticated full access notes" ON public.notes
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- candidate_channels (team access)
CREATE POLICY "Authenticated full access candidate_channels" ON public.candidate_channels
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- contact_channels (team access)
CREATE POLICY "Authenticated full access contact_channels" ON public.contact_channels
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- candidate_resumes (team access)
CREATE POLICY "Authenticated full access candidate_resumes" ON public.candidate_resumes
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- 5. integration_accounts: scoped to owner
CREATE POLICY "Users manage own integration_accounts" ON public.integration_accounts
  FOR ALL TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- 6. webhook_events: NO permissive policy = deny all client access (service_role only)
-- (RLS is enabled, no PERMISSIVE policy means PostgREST clients get zero rows)

-- 7. Secure views with security_barrier
ALTER VIEW public.candidate_summary SET (security_barrier = true);
ALTER VIEW public.inbox_threads SET (security_barrier = true);
ALTER VIEW public.send_out_board SET (security_barrier = true);
