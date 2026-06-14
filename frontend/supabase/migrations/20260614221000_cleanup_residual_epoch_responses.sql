-- Self-healing cleanup for the residual epoch last_responded_at corruption.
--
-- Called each tick by the backfill-entity-histories cron. Only touches people
-- who have ALREADY been re-fetched (last_history_synced_at IS NOT NULL) and
-- STILL have no inbound message — i.e. the now-working v2 history fetch
-- confirmed there's no real reply to recover, so the 1970 stamp is genuine
-- garbage. Nulls it and recomputes status (engaged→reached_out, since they
-- were contacted). Shrinks to a no-op as the full re-sync drains; bounded per
-- call so the cron stays light.
CREATE OR REPLACE FUNCTION public.cleanup_residual_epoch_responses(p_limit int DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  WITH targets AS (
    SELECT p.id
    FROM public.people p
    WHERE p.last_responded_at <= '2000-01-01'
      AND p.last_history_synced_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.messages m
        WHERE (m.candidate_id = p.id OR m.contact_id = p.id)
          AND m.direction = 'inbound'
      )
    LIMIT p_limit
  )
  UPDATE public.people p
  SET last_responded_at = NULL,
      status = CASE WHEN p.last_contacted_at IS NOT NULL THEN 'reached_out' ELSE 'new' END,
      updated_at = now()
  FROM targets t
  WHERE p.id = t.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
