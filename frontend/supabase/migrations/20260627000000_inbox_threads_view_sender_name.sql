-- Communication Hub: surface the inbound sender's name on inbox threads.
--
-- Unlinked conversations (no candidate_id/contact_id) rendered as "Unknown
-- sender" in the thread list even though the underlying messages carry the
-- real sender name (which is why the message pane could show e.g. "Kwaku A.
-- A." while the list could not). Recruiter InMails from people not yet in the
-- CRM are the common case.
--
-- Expose the latest inbound message's sender_name on the view so the list can
-- fall back to it: candidate_name || contact_name || sender_name. Also expose
-- avatar_url (the linked person's photo) so the inbox can render real avatars
-- instead of a generic channel glyph. CREATE OR REPLACE keeps every existing
-- column (append-only); consumers select * so the extra columns are
-- backwards-compatible.

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
    COALESCE(cand.last_sequence_sentiment_note, cont.last_sequence_sentiment_note) AS sentiment_note,
    -- Latest inbound message's sender name — appended at the end so CREATE OR
    -- REPLACE treats it as a new column (it cannot rename/reorder existing
    -- columns). The list falls back to this when the thread isn't linked to a
    -- CRM person yet.
    inbound.last_inbound_sender_name AS sender_name,
    -- Linked person's photo (candidate first, then contact) for inbox avatars.
    COALESCE(
      NULLIF(cand.avatar_url, ''), NULLIF(cand.profile_picture_url, ''),
      NULLIF(cont.avatar_url, ''), NULLIF(cont.profile_picture_url, '')
    ) AS avatar_url
FROM conversations c
  LEFT JOIN candidates cand ON cand.id = c.candidate_id
  LEFT JOIN contacts cont ON cont.id = c.contact_id
  LEFT JOIN LATERAL (
    SELECT m.created_at AS last_inbound_at,
           "left"(COALESCE(NULLIF(m.body, ''::text), m.subject, ''::text), 200) AS last_inbound_preview,
           NULLIF(TRIM(m.sender_name), '') AS last_inbound_sender_name
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
