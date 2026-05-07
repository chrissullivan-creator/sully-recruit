-- Add `has_attachments` to the inbox_threads view so the thread list can
-- show a paperclip badge without an N+1 query against messages.
--
-- Definition is true if ANY message in the conversation has at least one
-- entry in the attachments JSONB array (default '[]'::jsonb, see migration
-- 20260410000000).

DROP VIEW IF EXISTS public.inbox_threads;

CREATE VIEW public.inbox_threads
WITH (security_barrier = true) AS
SELECT
  c.id,
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
  EXISTS (
    SELECT 1
    FROM public.messages m
    WHERE m.conversation_id = c.id
      AND jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb)) > 0
  ) AS has_attachments
FROM public.conversations c
LEFT JOIN public.candidates cand ON cand.id = c.candidate_id
LEFT JOIN public.contacts cont ON cont.id = c.contact_id
LEFT JOIN LATERAL (
  SELECT
    m.created_at AS last_inbound_at,
    LEFT(COALESCE(NULLIF(m.body, ''), m.subject, ''), 200) AS last_inbound_preview
  FROM public.messages m
  WHERE m.conversation_id = c.id
    AND m.direction = 'inbound'
  ORDER BY m.created_at DESC
  LIMIT 1
) inbound ON true;

GRANT SELECT ON public.inbox_threads TO authenticated;
