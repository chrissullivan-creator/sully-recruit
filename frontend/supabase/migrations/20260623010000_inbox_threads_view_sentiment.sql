-- Communication Hub rework: surface reply sentiment on inbox threads.
--
-- The inbox now shows a sentiment badge + filter per thread. Sentiment is
-- stored per-person (people.last_sequence_sentiment, exposed through the
-- candidates/contacts views the inbox_threads view already joins), so this
-- just appends two COALESCE columns to the view. CREATE OR REPLACE keeps all
-- existing columns in place (append-only); consumers select * so the extra
-- columns are backwards-compatible.
--
-- NB: per-user scoping for the inbox/calls is enforced in the query layer
-- (see frontend use-inbox-scope.ts) — RLS stays permissive so backend jobs,
-- Joe, dashboards, and the service-role sequence engine keep working.

CREATE OR REPLACE VIEW public.inbox_threads AS
SELECT c.id,
    c.channel,
    c.subject,
    c.last_message_at,
    c.last_message_preview,
    inbound.last_inbound_at,
    inbound.last_inbound_preview,
    COALESCE(inbound.last_inbound_at, c.last_message_at) AS sort_at,
    c.is_read,
    c.is_archived,
    c.candidate_id,
    cand.full_name AS candidate_name,
    c.contact_id,
    cont.full_name AS contact_name,
    c.send_out_id,
    c.account_id,
    c.integration_account_id,
    c.owner_id,
    c.assigned_user_id,
    c.external_conversation_id,
    c.created_at,
    c.updated_at,
    (EXISTS (
      SELECT 1
      FROM messages m
      WHERE m.conversation_id = c.id
        AND jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb)) > 0
    )) AS has_attachments,
    c.flagged,
    c.snoozed_until,
    c.follow_up_at,
    c.status,
    outbound.last_outbound_at,
    c.woke_from_snooze_at,
    c.follow_up_at_set_at,
    c.follow_up_triggered_at,
    -- Reply sentiment (per-person) surfaced on the thread for the badge/filter.
    COALESCE(cand.last_sequence_sentiment, cont.last_sequence_sentiment) AS sentiment,
    COALESCE(cand.last_sequence_sentiment_note, cont.last_sequence_sentiment_note) AS sentiment_note
FROM conversations c
  LEFT JOIN candidates cand ON cand.id = c.candidate_id
  LEFT JOIN contacts cont ON cont.id = c.contact_id
  LEFT JOIN LATERAL (
    SELECT m.created_at AS last_inbound_at,
           "left"(COALESCE(NULLIF(m.body, ''::text), m.subject, ''::text), 200) AS last_inbound_preview
    FROM messages m
    WHERE m.conversation_id = c.id AND m.direction = 'inbound'::text
    ORDER BY m.created_at DESC
    LIMIT 1
  ) inbound ON true
  LEFT JOIN LATERAL (
    SELECT m.created_at AS last_outbound_at
    FROM messages m
    WHERE m.conversation_id = c.id AND m.direction = 'outbound'::text
    ORDER BY m.created_at DESC
    LIMIT 1
  ) outbound ON true;
