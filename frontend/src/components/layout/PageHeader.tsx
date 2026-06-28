import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Small eyebrow label above the title. */
  eyebrow?: string;
  /** Icon shown left of the title. */
  icon?: ReactNode;
  actions?: ReactNode;
  /** Optional row rendered below the header (tabs, filters). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, icon, actions, children, className }: PageHeaderProps) {
  return (
    <div className={cn('border-b border-card-border bg-card/50', className)}>
      <div className="flex items-center justify-between gap-4 px-8 py-5">
        <div className="flex items-center gap-3 min-w-0">
          {icon && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary [&_svg]:h-5 [&_svg]:w-5">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            )}
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground truncate">{title}</h1>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children && <div className="px-8 pb-3">{children}</div>}
    </div>
  );
}
