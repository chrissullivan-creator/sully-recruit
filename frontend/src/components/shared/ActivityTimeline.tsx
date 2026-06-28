import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TimelineEvent {
  icon?: ReactNode;
  title: ReactNode;
  /** Right-aligned timestamp (e.g. "10:15 AM"). */
  time?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
}

export interface TimelineGroup {
  /** e.g. "Today", "Yesterday", "May 28". */
  label: string;
  events: TimelineEvent[];
}

/**
 * Grouped activity timeline — the "Today / Yesterday" connector list seen in the
 * detail-page Activity panels and the dashboard feeds. Presentational only; pass
 * already-grouped events.
 */
export function ActivityTimeline({ groups, className }: { groups: TimelineGroup[]; className?: string }) {
  return (
    <div className={cn('space-y-5', className)}>
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <ul className="relative space-y-3 before:absolute before:left-[11px] before:top-1 before:bottom-1 before:w-px before:bg-card-border">
            {group.events.map((ev, i) => {
              const interactive = !!ev.onClick;
              return (
                <li
                  key={i}
                  onClick={ev.onClick}
                  className={cn(
                    'relative flex items-start gap-3 pl-0',
                    interactive && 'cursor-pointer group',
                  )}
                >
                  <span className="relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                    {ev.icon ?? <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className={cn('text-sm text-foreground truncate', interactive && 'group-hover:text-primary')}>
                        {ev.title}
                      </p>
                      {ev.time && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ev.time}</span>}
                    </div>
                    {ev.meta && <p className="text-xs text-muted-foreground truncate">{ev.meta}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
