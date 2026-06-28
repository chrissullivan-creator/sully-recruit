import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  title?: ReactNode;
  /** Small icon shown left of the title. */
  icon?: ReactNode;
  /** Right-aligned header controls (links, buttons, filters). */
  actions?: ReactNode;
  /** Remove inner padding on the body (e.g. for tables that manage their own). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * Titled white panel — the repeated surface across the redesign (AI Summary,
 * Job Information, Contact Overview, Recent Activity, …). Pure-white card on the
 * sage canvas with a hairline border, soft shadow, and an optional header row.
 */
export function SectionCard({
  title, icon, actions, flush, className, bodyClassName, children,
}: SectionCardProps) {
  return (
    <section className={cn(
      'rounded-2xl border border-card-border bg-card shadow-sm overflow-hidden',
      className,
    )}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-card-border">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
            {title && (
              <h3 className="text-sm font-semibold text-foreground truncate">{title}</h3>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && 'p-5', bodyClassName)}>{children}</div>
    </section>
  );
}
