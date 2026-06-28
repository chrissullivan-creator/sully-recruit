import { ReactNode } from 'react';
import { CheckCircle2, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/shared/SectionCard';
import { EmptyState } from '@/components/shared/EmptyState';

export interface NextAction {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  done?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
}

interface NextActionsCardProps {
  title?: ReactNode;
  actions?: ReactNode;
  items: NextAction[];
  emptyLabel?: string;
  className?: string;
}

/**
 * NextActionsCard — the "Next actions" / to-do shell on Overview tabs.
 * Presentational: pass items + toggle/click handlers, no data fetching.
 */
export function NextActionsCard({
  title = 'Next actions', actions, items, emptyLabel = 'Nothing queued', className,
}: NextActionsCardProps) {
  return (
    <SectionCard title={title} icon={<ListTodo className="h-4 w-4" />} actions={actions} className={className}>
      {items.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={emptyLabel} className="py-8" />
      ) : (
        <ul className="space-y-1">
          {items.map((a) => (
            <li
              key={a.id}
              className={cn(
                'group flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50',
                a.onClick && 'cursor-pointer',
              )}
              onClick={a.onClick}
            >
              <button
                type="button"
                aria-label={a.done ? 'Mark not done' : 'Mark done'}
                onClick={(e) => { e.stopPropagation(); a.onToggle?.(); }}
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  a.done ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border text-transparent hover:border-primary',
                )}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm text-foreground', a.done && 'text-muted-foreground line-through')}>
                  {a.title}
                </p>
                {a.meta && <p className="text-xs text-muted-foreground">{a.meta}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
