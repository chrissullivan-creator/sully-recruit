-- ============================================================================
-- Fix all tables with RLS enabled but missing policies, and tables with
-- RLS not enabled. Also fix send_outs stage check constraint.
-- ============================================================================

-- Tables with RLS enabled but zero policies (all operations blocked)
CREATE POLICY IF NOT EXISTS "Authenticated full access ai_call_notes"
  ON public.ai_call_notes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access call_processing_queue"
  ON public.call_processing_queue FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access candidates_import_staging"
  ON public.candidates_import_staging FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access company_domains"
  ON public.company_domains FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access contact_embeddings"
  ON public.contact_embeddings FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access morning_briefings"
  ON public.morning_briefings FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access reply_sentiment"
  ON public.reply_sentiment FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Authenticated full access resume_embeddings"
  ON public.resume_embeddings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Table with RLS not enabled at all
ALTER TABLE public.job_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Authenticated full access job_contacts"
  ON public.job_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Fix send_outs stage check constraint (was too restrictive — missing 'new',
-- 'reached_out', 'pitch', 'sent', 'submitted', 'interviewing', 'withdrew', 'lead')
ALTER TABLE public.send_outs DROP CONSTRAINT IF EXISTS send_outs_stage_check;
ALTER TABLE public.send_outs ADD CONSTRAINT send_outs_stage_check
  CHECK (stage = ANY (ARRAY[
    'new', 'reached_out', 'pitch', 'send_out', 'sent', 'submitted',
    'interviewing', 'interview', 'offer', 'placed', 'rejected', 'withdrew', 'lead'
  ]));
