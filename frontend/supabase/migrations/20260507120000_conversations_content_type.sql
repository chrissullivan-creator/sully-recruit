-- Persist Unipile's per-chat content_type on conversations so we don't
-- have to re-derive InMail vs Classic from inference. The webhook and
-- backfill tasks now capture it; the reclassify task back-stamps it
-- on existing rows by re-pulling each chat from Unipile v2.
--
-- Unipile values (from chat-start.types.ts):
--   inmail | sponsored | linkedin_offer
-- We also accept NULL for Classic DMs (Unipile omits the field there).

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS content_type TEXT;

-- Helpful when reclassifying or building a "show only InMails" filter.
CREATE INDEX IF NOT EXISTS idx_conversations_content_type
  ON public.conversations(content_type)
  WHERE content_type IS NOT NULL;
