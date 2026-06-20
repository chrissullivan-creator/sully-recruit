-- OOO reschedule + enrollment-level sentiment.
--
-- 1) sequence_enrollments.reply_sentiment / reply_sentiment_note
--    These were authored in 20260406100000_add_sequence_enrollment_fields.sql
--    but never reached production: that file was recorded under an earlier
--    version (20260405061613) whose body only added sequences.job_ids, so the
--    ALTER adding these two columns never ran. intel-extraction.ts writes them
--    and SequenceAnalyticsPage reads sequence_enrollments.reply_sentiment for
--    the "Sentiment breakdown" chart — with the column absent the chart was
--    always empty ("0% / no sentiment data"). Add them idempotently and
--    backfill from the reply_sentiment log so historical replies show up.
--
-- 2) people.ooo_until
--    Drives the out-of-office handling: when a contact returns an auto-reply,
--    the sequence engine reschedules the next step to the day after their
--    stated return date (instead of stopping), and stamps the return date here
--    so the UI can surface an "Out of office until …" badge.

ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS reply_sentiment TEXT,
  ADD COLUMN IF NOT EXISTS reply_sentiment_note TEXT;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS ooo_until TIMESTAMPTZ;

-- Backfill enrollment sentiment from the most recent reply_sentiment row per
-- enrollment (only rows that carry an enrollment_id). Going forward the webhook
-- processors populate reply_sentiment directly.
UPDATE public.sequence_enrollments se
SET reply_sentiment = rs.sentiment,
    reply_sentiment_note = rs.summary
FROM (
  SELECT DISTINCT ON (enrollment_id) enrollment_id, sentiment, summary
  FROM public.reply_sentiment
  WHERE enrollment_id IS NOT NULL
  ORDER BY enrollment_id, analyzed_at DESC NULLS LAST
) rs
WHERE se.id = rs.enrollment_id
  AND se.reply_sentiment IS NULL;
