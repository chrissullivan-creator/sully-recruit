-- Pass 7: record-of-truth unified activity view.
--
-- v_person_activity unions every activity source into a single timeline keyed by
-- candidate.id (which now holds both candidate-type and client-type rows).
-- Use it to render a per-person activity feed without joining 13 tables.
--
-- Activity types: message, call, ai_note, status_change, stage_change, note,
-- pitch, sendout, submission, interview, placement, rejection, merge.
--
-- Usage:
--   SELECT * FROM v_person_activity WHERE person_id = '<uuid>' ORDER BY happened_at DESC;

DROP VIEW IF EXISTS v_person_activity;
CREATE VIEW v_person_activity
WITH (security_invoker = true) AS
  SELECT
    'message'::text                                              AS activity_type,
    COALESCE(candidate_id, contact_id)                           AS person_id,
    COALESCE(sent_at, received_at, created_at)                   AS happened_at,
    direction || ' ' || channel || ' message'                    AS summary,
    jsonb_build_object('channel', channel, 'direction', direction, 'subject', subject, 'sender_address', sender_address, 'recipient_address', recipient_address) AS details,
    owner_id                                                     AS actor_user_id,
    'messages'::text                                             AS source_table,
    id                                                           AS source_id
  FROM messages WHERE COALESCE(candidate_id, contact_id) IS NOT NULL

  UNION ALL
  SELECT 'call', COALESCE(candidate_id, contact_id), COALESCE(started_at, created_at),
         direction || ' call (' || COALESCE(duration_seconds::text || 's', 'no duration') || ')',
         jsonb_build_object('direction', direction, 'duration_seconds', duration_seconds, 'phone_number', phone_number, 'summary', summary),
         owner_id, 'call_logs', id
  FROM call_logs WHERE COALESCE(candidate_id, contact_id) IS NOT NULL

  UNION ALL
  SELECT 'ai_note', COALESCE(candidate_id, contact_id), COALESCE(call_started_at, created_at),
         'AI call note: ' || LEFT(COALESCE(ai_summary, 'no summary'), 100),
         jsonb_build_object('duration_seconds', call_duration_seconds, 'transcription_provider', transcription_provider, 'recording_url', recording_url),
         owner_id, 'ai_call_notes', id
  FROM ai_call_notes WHERE COALESCE(candidate_id, contact_id) IS NOT NULL

  UNION ALL
  SELECT 'status_change', entity_id, created_at,
         'status: ' || COALESCE(from_status, 'null') || ' -> ' || to_status,
         jsonb_build_object('from_status', from_status, 'to_status', to_status, 'triggered_by', triggered_by, 'reasoning', reasoning),
         actor_user_id, 'status_change_log', id
  FROM status_change_log WHERE entity_type IN ('candidate', 'contact')

  UNION ALL
  SELECT 'stage_change', entity_id, created_at,
         'stage: ' || COALESCE(from_stage, 'null') || ' -> ' || to_stage,
         jsonb_build_object('from_stage', from_stage, 'to_stage', to_stage, 'trigger_source', trigger_source, 'ai_reasoning', ai_reasoning),
         triggered_by_user_id, 'stage_transitions', id
  FROM stage_transitions WHERE entity_type IN ('candidate', 'contact')

  UNION ALL
  SELECT 'note', entity_id, created_at,
         'note: ' || LEFT(COALESCE(note, ''), 100),
         jsonb_build_object('note_source', note_source),
         CASE WHEN created_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN created_by::uuid ELSE NULL END,
         'notes', id
  FROM notes WHERE entity_type IN ('candidate', 'contact')

  UNION ALL
  SELECT 'pitch', candidate_id, pitched_at,
         'pitched for job ' || job_id::text,
         jsonb_build_object('job_id', job_id, 'notes', notes),
         pitched_by, 'pitches', id
  FROM pitches

  UNION ALL
  SELECT 'sendout', candidate_id, COALESCE(sent_to_client_at, created_at),
         'sendout to client (stage: ' || COALESCE(stage, 'unknown') || ')',
         jsonb_build_object('job_id', job_id, 'stage', stage, 'outcome', outcome),
         recruiter_id, 'send_outs', id
  FROM send_outs

  UNION ALL
  SELECT 'submission', candidate_id, submitted_at,
         'submitted to ' || COALESCE(submitted_to, 'client'),
         jsonb_build_object('job_id', job_id, 'submitted_to', submitted_to, 'notes', notes),
         submitted_by, 'submissions', id
  FROM submissions

  UNION ALL
  SELECT 'interview', candidate_id, COALESCE(scheduled_at, created_at),
         'interview round ' || COALESCE(round::text, '?') || ' (' || COALESCE(stage, 'pending') || ')',
         jsonb_build_object('job_id', job_id, 'stage', stage, 'round', round, 'outcome', outcome, 'interviewer_name', interviewer_name),
         owner_id, 'interviews', id
  FROM interviews

  UNION ALL
  SELECT 'placement', candidate_id, COALESCE(placed_at, created_at),
         'placed @ salary ' || COALESCE(salary::text, '?'),
         jsonb_build_object('job_id', job_id, 'salary', salary, 'start_date', start_date, 'falloff', falloff),
         NULL::uuid, 'placements', id
  FROM placements

  UNION ALL
  SELECT 'rejection', candidate_id, rejected_at,
         'rejected by ' || COALESCE(rejected_by_party, 'unknown') || ' at ' || COALESCE(prior_stage, 'unknown stage'),
         jsonb_build_object('job_id', job_id, 'rejection_reason', rejection_reason, 'prior_stage', prior_stage),
         NULL::uuid, 'rejections', id
  FROM rejections

  UNION ALL
  SELECT 'merge', survivor_id, created_at,
         'merged record ' || merged_id::text || ' into this person',
         jsonb_build_object('merged_id', merged_id, 'merged_data', merged_data, 'tables_updated', tables_updated),
         merged_by, 'candidate_merge_log', id
  FROM candidate_merge_log;

COMMENT ON VIEW v_person_activity IS
  'Unified per-person activity timeline. Filter by person_id to get a record-of-truth feed for one candidate or client. Order by happened_at DESC for chronological view.';
