-- Phase 5: extend inbox_threads view with last_outbound_at + the wake +
-- follow-up tracking columns added in Phase 4.5.
--
-- last_outbound_at powers the Sent folder view (rows where at least one
-- outbound message exists, sorted by outbound recency).

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
    c.follow_up_triggered_at
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
