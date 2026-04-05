-- ============================================================================
-- Fix missing RLS on resumes table and add storage policies for resumes bucket
-- ============================================================================

-- 1. Enable RLS on resumes table (was never enabled after consolidation from candidate_resumes)
ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;

-- Match the team-access pattern used by formatted_resumes and other shared tables
CREATE POLICY "Authenticated full access resumes"
  ON public.resumes FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 2. Create resumes storage bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('resumes', 'resumes', false)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS policies for resumes bucket
CREATE POLICY "Authenticated users can upload resumes"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'resumes');

CREATE POLICY "Authenticated users can read resumes"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'resumes');

CREATE POLICY "Authenticated users can update resumes"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'resumes');

CREATE POLICY "Authenticated users can delete resumes"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'resumes');
