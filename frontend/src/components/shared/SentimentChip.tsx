import { cn } from '@/lib/utils';

// Shared sentiment styling + chip. Extracted from candidate-detail/CandidateFields
// so the inbox (thread rows + filter) and the candidate detail render one
// consistent sentiment treatment. Values match reply_sentiment.sentiment /
// people.last_sequence_sentiment.
export const SENTIMENT_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  interested:       { label: 'Interested',       bg: 'bg-primary',     text: 'text-white' },
  positive:         { label: 'Positive',         bg: 'bg-green-500/15',  text: 'text-green-500' },
  maybe:            { label: 'Maybe',            bg: 'bg-accent/15',  text: 'text-accent' },
  neutral:          { label: 'Neutral',          bg: 'bg-gray-500/15',   text: 'text-gray-400' },
  negative:         { label: 'Negative',         bg: 'bg-orange-500/15', text: 'text-orange-500' },
  not_interested:   { label: 'Not Interested',   bg: 'bg-red-500/15',    text: 'text-red-500' },
  do_not_contact:   { label: 'Do Not Contact',   bg: 'bg-red-900/20',    text: 'text-red-700' },
  ooo:              { label: 'Out of Office',     bg: 'bg-blue-500/15',   text: 'text-blue-500' },
};

// Buckets for the inbox sentiment filter (collapses the raw values into the
// few groups a recruiter actually triages by).
export interface SentimentBucket { key: string; label: string; values: string[] }
export const SENTIMENT_BUCKETS: SentimentBucket[] = [
  { key: 'positive', label: 'Positive', values: ['interested', 'positive'] },
  { key: 'maybe', label: 'Maybe / Neutral', values: ['maybe', 'neutral'] },
  { key: 'negative', label: 'At-risk / Negative', values: ['negative', 'not_interested', 'do_not_contact'] },
  { key: 'ooo', label: 'Out of office', values: ['ooo'] },
];

/** Map a raw sentiment value to its bucket key (or null). */
export function sentimentBucketKey(sentiment?: string | null): string | null {
  if (!sentiment) return null;
  return SENTIMENT_BUCKETS.find((b) => b.values.includes(sentiment))?.key ?? null;
}

export const SentimentChip = ({
  sentiment,
  note,
  compact = false,
}: {
  sentiment?: string | null;
  note?: string | null;
  compact?: boolean;
}) => {
  if (!sentiment) return null;
  const cfg =
    SENTIMENT_CONFIG[sentiment] ??
    { label: sentiment.replace(/_/g, ' '), bg: 'bg-muted', text: 'text-muted-foreground' };

  if (compact) {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium capitalize',
          cfg.bg,
          cfg.text,
        )}
        title={note || cfg.label}
      >
        {cfg.label}
      </span>
    );
  }

  return (
    <div>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
          cfg.bg,
          cfg.text,
        )}
      >
        {cfg.label}
      </span>
      {note && <p className="text-[10px] italic text-muted-foreground mt-0.5 line-clamp-2">{note}</p>}
    </div>
  );
};
