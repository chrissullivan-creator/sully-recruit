-- Merge fragmented LinkedIn / Recruiter conversations.
--
-- Background: inbound LinkedIn (esp. Recruiter/InMail) webhooks arrive on the v2
-- envelope carrying the v2 `acc_xxx` account id, but process-unipile-event.ts
-- resolved integration_account_id by matching ONLY the v1 `unipile_account_id`
-- column. That left integration_account_id NULL, and because the conversation
-- UNIQUE index is (integration_account_id, channel, external_conversation_id)
-- and Postgres treats NULLs as DISTINCT, the find-or-create dedup silently
-- broke: every inbound message spawned a brand-new conversation row for the
-- SAME chat. Result — a single LinkedIn thread shattered across up to 17
-- conversation rows, each holding one message (and a few empty shells from the
-- idempotency-race path), so opening a thread showed one stray line or the
-- "Conversation starting…" empty state ("blank on context").
--
-- The code fix (match unipile_account_id OR unipile_account_id_v2, plus a
-- dedup lookup that tolerates NULL iaid) stops NEW fragmentation. This
-- migration consolidates the EXISTING fragments. No messages are deleted —
-- they are reassigned to a single canonical conversation per chat; only the
-- duplicate conversation shells are removed.
--
-- Also reclassifies LinkedIn rows whose chat id carries the `RECRUITER_`
-- prefix to channel 'linkedin_recruiter' (they belong in the InMail/Recruiter
-- inbox, not "regular" LinkedIn), and syncs each message's channel to its
-- conversation.

DO $$
DECLARE
  grp RECORD;
  canonical_id uuid;
  canon_channel text;
  v_candidate uuid;
  v_contact uuid;
  v_iaid uuid;
BEGIN
  -- 1) Collapse every chat (grouped by external_conversation_id) that has more
  --    than one conversation row down to a single canonical conversation.
  FOR grp IN
    SELECT external_conversation_id
    FROM conversations
    WHERE channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
      AND external_conversation_id IS NOT NULL
    GROUP BY external_conversation_id
    HAVING count(*) > 1
  LOOP
    canon_channel := CASE
      WHEN grp.external_conversation_id LIKE 'RECRUITER\_%' THEN 'linkedin_recruiter'
      ELSE 'linkedin'
    END;

    -- Canonical = an already-linked row if any, else the earliest created.
    SELECT id INTO canonical_id
    FROM conversations
    WHERE external_conversation_id = grp.external_conversation_id
      AND channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
    ORDER BY (candidate_id IS NULL AND contact_id IS NULL), created_at ASC, id ASC
    LIMIT 1;

    -- Capture the best person link / account id across ALL rows in the group
    -- (canonical first, then any sibling) BEFORE we touch anything, so we can
    -- delete the duplicates before stamping these onto the canonical — stamping
    -- first would transiently create two rows sharing the unique key.
    SELECT
      (SELECT s.candidate_id FROM conversations s
         WHERE s.external_conversation_id = grp.external_conversation_id
           AND s.channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
           AND s.candidate_id IS NOT NULL
         ORDER BY (s.id = canonical_id) DESC LIMIT 1),
      (SELECT s.contact_id FROM conversations s
         WHERE s.external_conversation_id = grp.external_conversation_id
           AND s.channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
           AND s.contact_id IS NOT NULL
         ORDER BY (s.id = canonical_id) DESC LIMIT 1),
      (SELECT s.integration_account_id FROM conversations s
         WHERE s.external_conversation_id = grp.external_conversation_id
           AND s.channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
           AND s.integration_account_id IS NOT NULL
         ORDER BY (s.id = canonical_id) DESC LIMIT 1)
    INTO v_candidate, v_contact, v_iaid;

    -- Reassign every message from the sibling rows onto the canonical row.
    UPDATE messages m
    SET conversation_id = canonical_id
    FROM conversations c
    WHERE m.conversation_id = c.id
      AND c.external_conversation_id = grp.external_conversation_id
      AND c.channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
      AND m.conversation_id <> canonical_id;

    -- Drop the now-empty sibling shells.
    DELETE FROM conversations
    WHERE external_conversation_id = grp.external_conversation_id
      AND channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
      AND id <> canonical_id;

    -- Now the canonical is the only row for this chat — safe to stamp the merged
    -- link/account, normalize the channel, and refresh the preview/timestamp.
    UPDATE conversations canon
    SET candidate_id = COALESCE(canon.candidate_id, v_candidate),
        contact_id   = COALESCE(canon.contact_id, v_contact),
        integration_account_id = COALESCE(canon.integration_account_id, v_iaid),
        channel = canon_channel,
        last_message_at = COALESCE(
          (SELECT max(created_at) FROM messages WHERE conversation_id = canonical_id),
          canon.last_message_at),
        last_message_preview = LEFT(COALESCE(
          (SELECT btrim(body) FROM messages
             WHERE conversation_id = canonical_id AND NULLIF(btrim(body), '') IS NOT NULL
             ORDER BY created_at DESC LIMIT 1),
          canon.last_message_preview, ''), 200),
        updated_at = now()
    WHERE canon.id = canonical_id;
  END LOOP;

  -- 2) Reclassify any remaining single 'linkedin' rows that are actually
  --    Recruiter chats (RECRUITER_ chat-id prefix). After step 1 each chat has
  --    exactly one conversation row, so this can't collide on the unique index.
  UPDATE conversations
  SET channel = 'linkedin_recruiter', updated_at = now()
  WHERE channel = 'linkedin'
    AND external_conversation_id LIKE 'RECRUITER\_%';

  -- 3) Sync each LinkedIn-family message's channel to its conversation's channel
  --    (fixes recruiter messages that were stored as plain 'linkedin').
  UPDATE messages m
  SET channel = c.channel
  FROM conversations c
  WHERE m.conversation_id = c.id
    AND c.channel IN ('linkedin', 'linkedin_recruiter', 'linkedin_sales_nav')
    AND m.channel IS DISTINCT FROM c.channel;
END $$;
