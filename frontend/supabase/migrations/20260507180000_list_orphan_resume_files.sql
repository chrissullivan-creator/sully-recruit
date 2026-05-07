-- Expose orphan résumé storage objects (those without a matching
-- public.resumes.file_path) to the recover-orphan-resumes Trigger.dev
-- task. Service-role JWT can already read storage.objects directly,
-- but a typed RPC keeps the task code clean.

CREATE OR REPLACE FUNCTION public.list_orphan_resume_files(
  p_since TIMESTAMPTZ DEFAULT '2026-04-15'::timestamptz,
  p_limit INT DEFAULT 200
)
RETURNS TABLE (name TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = 'resumes'
    AND o.created_at >= p_since
    AND NOT EXISTS (
      SELECT 1 FROM public.resumes r WHERE r.file_path = o.name
    )
  ORDER BY o.created_at ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.list_orphan_resume_files(TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_orphan_resume_files(TIMESTAMPTZ, INT) TO service_role;
