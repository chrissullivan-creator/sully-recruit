-- ============================================================================
-- Consolidate candidate_resumes into resumes table + create formatted_resumes
-- ============================================================================

-- 1. Add missing columns to resumes table (from candidate_resumes)
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS file_size INTEGER;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS parse_error TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 2. Migrate data from candidate_resumes into resumes (skip duplicates by file_path + candidate_id)
INSERT INTO public.resumes (candidate_id, file_path, file_name, mime_type, file_size, raw_text, parsed_json, ai_summary, parse_status, parse_error, source, file_url, created_at, updated_at)
SELECT
  cr.candidate_id,
  cr.file_path,
  cr.file_name,
  cr.mime_type,
  cr.file_size,
  cr.raw_text,
  cr.parsed_json,
  cr.ai_summary,
  cr.parse_status,
  cr.parse_error,
  cr.source,
  NULL, -- file_url will be generated client-side from storage
  cr.created_at,
  cr.updated_at
FROM public.candidate_resumes cr
WHERE NOT EXISTS (
  SELECT 1 FROM public.resumes r
  WHERE r.candidate_id = cr.candidate_id
  AND r.file_path = cr.file_path
);

-- 3. Create formatted_resumes table (client-facing resume versions)
CREATE TABLE IF NOT EXISTS public.formatted_resumes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  resume_id UUID REFERENCES public.resumes(id) ON DELETE SET NULL,
  job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  version_label TEXT NOT NULL DEFAULT 'v1',
  file_path TEXT,
  file_name TEXT,
  mime_type TEXT DEFAULT 'application/pdf',
  file_size INTEGER,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS for formatted_resumes
ALTER TABLE public.formatted_resumes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access formatted_resumes"
  ON public.formatted_resumes FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Updated_at trigger for formatted_resumes
CREATE TRIGGER update_formatted_resumes_updated_at
  BEFORE UPDATE ON public.formatted_resumes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Drop candidate_resumes table
DROP TABLE IF EXISTS public.candidate_resumes CASCADE;
