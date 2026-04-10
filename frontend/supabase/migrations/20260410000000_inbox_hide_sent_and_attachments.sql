-- =====================================================
-- Inbox: show latest INBOUND message as preview (hide sent
-- messages from the thread list) and add attachment support
-- on messages.
-- =====================================================

-- 1) Add attachments column to messages.
--    Shape: JSON array of { name, url, storage_path, mime_type, size }
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2) Rebuild inbox_threads view with last_inbound_at / last_inbound_preview
--    plus a sort_at column that prefers the most recent inbound message
--    (so replies you send do not bump conversations in the list).
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
  c.updated_at
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

-- 3) Storage bucket for message attachments (private; authenticated read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('message-attachments', 'message-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users can upload message attachments" ON storage.objects;
CREATE POLICY "Authenticated users can upload message attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'message-attachments');

DROP POLICY IF EXISTS "Authenticated users can read message attachments" ON storage.objects;
CREATE POLICY "Authenticated users can read message attachments"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'message-attachments');

DROP POLICY IF EXISTS "Authenticated users can delete message attachments" ON storage.objects;
CREATE POLICY "Authenticated users can delete message attachments"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'message-attachments');
