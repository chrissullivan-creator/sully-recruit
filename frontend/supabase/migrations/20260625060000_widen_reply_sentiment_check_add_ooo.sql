-- The AI sentiment vocabulary (intel-extraction.ts) and the analytics page both
-- include 'ooo' (out-of-office auto-replies) and 'booked_meeting', but the
-- reply_sentiment CHECK was stale and only allowed 7 values — so every OOO reply
-- failed to insert ("reply_sentiment_sentiment_check"). Widen it to the full vocab.
alter table public.reply_sentiment drop constraint if exists reply_sentiment_sentiment_check;
alter table public.reply_sentiment add constraint reply_sentiment_sentiment_check
  check (sentiment = any (array[
    'positive','interested','neutral','negative','not_interested','maybe',
    'do_not_contact','ooo','booked_meeting'
  ]));
