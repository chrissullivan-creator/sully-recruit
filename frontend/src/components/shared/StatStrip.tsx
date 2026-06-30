import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface StatItem {
  label: string;
  value: ReactNode;
  /** Secondary line under the value (e.g. delta, sublabel). */
  hint?: ReactNode;
  /** Tints the value gold for emphasis (e.g. revenue/offer figures). */
  accent?: boolean;
  onClick?: () => void;
}

/**
 * Compact horizontal KPI strip — the "14 Years Exp · $250K Base · 75% Bonus"
 * row in the detail headers and the dashboard/send-out metric strips. Items are
 * evenly distributed and divided by hairline rules. Use `MetricCard` instead
 * when you want larger, individually-bordered KPI cards.
 */
export function StatStrip({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <div className={cn(
      // Mobile: wrap into a 2/3-col grid so 6 KPIs stay readable at phone
      // width. Desktop (lg+): the even N-column strip on a single row.
      'grid grid-cols-2 sm:grid-cols-3 divide-x divide-y lg:divide-y-0 divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm',
      'lg:grid-cols-[repeat(var(--stat-cols),minmax(0,1fr))]',
      className,
    )}
      style={{ ['--stat-cols' as any]: items.length }}
    >
      {items.map((it, i) => {
        const interactive = !!it.onClick;
        return (
          <div
            key={i}
            onClick={it.onClick}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.onClick?.(); } } : undefined}
            className={cn(
              'px-4 py-3 min-w-0',
              interactive && 'cursor-pointer transition-colors hover:bg-muted/40',
            )}
          >
            <p className={cn(
              'text-xl font-bold tabular-nums leading-tight truncate',
              it.accent ? 'text-accent' : 'text-foreground',
            )}>
              {it.value}
            </p>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate">
              {it.label}
            </p>
            {it.hint && <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{it.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
