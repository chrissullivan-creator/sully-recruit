import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AISummaryCard } from '@/components/shared/AISummaryCard';

export interface SuggestionChip {
  label: string;
  onClick: () => void;
}

interface SummaryCardProps {
  /** Defaults to "Joe Says". */
  title?: string;
  loading?: boolean;
  actions?: ReactNode;
  /** Quick-prompt chips (Ask Joe context). */
  suggestions?: SuggestionChip[];
  className?: string;
  children?: ReactNode;
}

/**
 * SummaryCard — the Overview "Ask Joe / AI Summary" surface. A presentational
 * shell over AISummaryCard that adds a loading state and optional suggestion
 * chips. All AI data is passed in; this component owns no fetching.
 */
export function SummaryCard({
  title = 'Joe Says', loading, actions, suggestions, className, children,
}: SummaryCardProps) {
  return (
    <AISummaryCard title={title} actions={actions} className={className}>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Thinking…
        </div>
      ) : (
        children
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={s.onClick}
              className={cn(
                'rounded-full border border-primary/20 bg-card/70 px-3 py-1 text-xs font-medium text-foreground',
                'transition-colors hover:border-accent/40 hover:bg-accent/5',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </AISummaryCard>
  );
}
