-- Audit section 2 (security hardening).

-- 2a: the resumes bucket (candidate PII) was public=true, so any resume file was
-- downloadable via unauthenticated URL. The app serves resumes exclusively via
-- createSignedUrl, so private does not break previews. (send-outs and
-- sequence-attachments stay public: their URLs are emailed to external recipients.)
UPDATE storage.buckets SET public = false WHERE id = 'resumes';

-- 2b: a SECURITY DEFINER cleanup function was executable by anonymous callers. EXECUTE
-- had been granted to PUBLIC, so revoke from PUBLIC and re-grant only to service_role.
REVOKE EXECUTE ON FUNCTION public.cleanup_residual_epoch_responses(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_residual_epoch_responses(integer) TO service_role;

-- 2d (defense-in-depth): RLS already denies anon all rows on these tables, but the blanket
-- anon SELECT *grant* is the only backstop if a policy is ever misconfigured. Remove the
-- grant on the clearly-internal PII/secrets tables. The logged-in app uses the
-- authenticated role and is unaffected; no anon/public page reads these.
REVOKE SELECT ON
  public.people,
  public.messages,
  public.resumes,
  public.user_oauth_tokens,
  public.integration_accounts,
  public.oauth_states,
  public.app_settings,
  public.audit_log,
  public.call_logs,
  public.notes,
  public.ai_call_notes,
  public.candidate_documents
FROM anon;
