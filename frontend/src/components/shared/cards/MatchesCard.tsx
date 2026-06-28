import { ReactNode } from 'react';
import { Sparkles, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/shared/SectionCard';
import { EmptyState } from '@/components/shared/EmptyState';

export interface MatchItem {
  id: string;
  /** Avatar / logo node. */
  avatar?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 0–100 match score; renders a gold pill when present. */
  score?: number | null;
  badge?: ReactNode;
  onClick?: () => void;
}

interface MatchesCardProps {
  title?: ReactNode;
  actions?: ReactNode;
  items: MatchItem[];
  emptyLabel?: string;
  className?: string;
}

/**
 * MatchesCard — the "Job matches" / "Top candidates" list shell. Each row is an
 * avatar/logo + title/subtitle + optional match-score pill. Presentational.
 */
export function MatchesCard({
  title = 'Job matches', actions, items, emptyLabel = 'No matches yet', className,
}: MatchesCardProps) {
  return (
    <SectionCard title={title} icon={<Target className="h-4 w-4" />} actions={actions} className={className}>
      {items.length === 0 ? (
        <EmptyState icon={Sparkles} title={emptyLabel} className="py-8" />
      ) : (
        <ul className="divide-y divide-card-border">
          {items.map((m) => (
            <li
              key={m.id}
              onClick={m.onClick}
              className={cn(
                'flex items-center gap-3 py-2.5 first:pt-0 last:pb-0',
                m.onClick && 'cursor-pointer transition-colors hover:bg-muted/40 -mx-2 px-2 rounded-lg',
              )}
            >
              {m.avatar && <div className="shrink-0">{m.avatar}</div>}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{m.title}</p>
                {m.subtitle && <p className="text-xs text-muted-foreground truncate">{m.subtitle}</p>}
              </div>
              {m.badge}
              {m.score !== undefined && m.score !== null && (
                <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent">
                  {Math.round(m.score)}%
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
