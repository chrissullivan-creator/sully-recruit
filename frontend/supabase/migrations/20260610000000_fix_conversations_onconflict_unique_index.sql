-- Fix the conversation-upsert 42P10 that silently blocked creation of ALL new
-- conversations since ~May 19 2026 (and froze Recruiter-InMail ingestion).
--
-- Both LinkedIn backfills (v1 backfill-linkedin-messages + v2
-- backfill-linkedin-messages-v2) and backfill-emails upsert conversations with
--   ON CONFLICT (integration_account_id, channel, external_conversation_id)
-- That column triple was only covered by TWO *partial* unique indexes:
--   - uq_conversations_provider_external
--       WHERE external_conversation_id IS NOT NULL AND integration_account_id IS NOT NULL
--   - uniq_conversations_external_id   (added 20260511150000)
--       WHERE external_conversation_id IS NOT NULL AND external_conversation_id <> ''
--
-- PostgreSQL's column-only ON CONFLICT inference CANNOT use a partial index as
-- an arbiter (verified empirically: a single partial index fails the same way;
-- only a NON-partial index works), so every such upsert raised
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- Classic LinkedIn DMs masked the bug because their conversations already
-- existed (the upsert hit the SELECT-first early return and never ran the
-- INSERT ... ON CONFLICT). Recruiter InMail chats arrive with brand-new
-- RECRUITER_2-* ids that have no pre-existing row, so they hit the upsert and
-- errored out — leaving linkedin_recruiter ingestion frozen at May 21 2026.
--
-- Fix: add a single NON-partial unique index on the exact triple so the
-- column-only ON CONFLICT can infer it, then drop the two redundant partial
-- indexes it supersedes.
--
-- Verified safe before applying:
--   * No (all-non-null) triple is duplicated, so the non-partial index builds.
--   * Rows with NULL integration_account_id (503 of them) stay mutually
--     non-conflicting: NULLs are distinct in a unique index by default, under
--     both the old partial indexes and the new one — so this loosens nothing.
--
-- Already applied live via MCP (Supabase migration
-- fix_conversations_onconflict_unique_index); this file tracks it in the repo.
-- Idempotent so a later `supabase db push` is a no-op.

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_account_channel_external
  ON public.conversations (integration_account_id, channel, external_conversation_id);

DROP INDEX IF EXISTS public.uq_conversations_provider_external;
DROP INDEX IF EXISTS public.uniq_conversations_external_id;
