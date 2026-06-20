-- Audit fix 1a: cron job 37 (mark_stale_candidates) set status='stale', which violates
-- the candidates_status_check constraint (only new/reached_out/engaged are allowed), so
-- it failed every morning and no candidate was ever marked stale. Staleness is tracked by
-- the stale_at timestamp, not the status enum -- set that instead and leave status alone.
SELECT cron.alter_job(
  job_id := 37,
  command := $cmd$
  UPDATE people p
  SET stale_at = NOW()
  WHERE p.type = 'candidate'
    AND p.stale_at IS NULL
    AND p.status IN ('reached_out', 'engaged')
    AND p.last_contacted_at IS NOT NULL
    AND p.last_contacted_at < NOW() - INTERVAL '120 days'
    AND (p.last_responded_at IS NULL OR p.last_responded_at < NOW() - INTERVAL '120 days')
    AND NOT EXISTS (
      SELECT 1 FROM candidate_jobs cj
      WHERE cj.candidate_id = p.id
        AND cj.pipeline_stage IN ('reached_out','pitch','ready_to_send','sent','interviewing')
    );
  $cmd$
);
