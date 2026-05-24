-- Phase 4: extend inbox_threads view to expose the new workflow columns
-- (flagged, snoozed_until, follow_up_at, status) so the inbox list
-- query gets them without a separate join.
--
-- CREATE OR REPLACE VIEW can only append new columns (it can't reorder),
-- so the new fields land at the end of the select list.

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
    c.status
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
  ) inbound ON true;
