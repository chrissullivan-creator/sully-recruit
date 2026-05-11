-- Prevent duplicate conversation rows from LinkedIn backfill / webhook handlers.
-- Bug: `upsertConversation` used `.maybeSingle()` to find an existing row,
-- which returns null on multi-match — so once 2+ duplicates existed every
-- cron run inserted another. 30k+ blank rows accumulated on a few chats.
--
-- Drop the non-unique index of the same shape (it was just for lookups).
DROP INDEX IF EXISTS public.idx_conversations_external_conversation_id;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_external_id
ON public.conversations (integration_account_id, channel, external_conversation_id)
WHERE external_conversation_id IS NOT NULL AND external_conversation_id <> '';
