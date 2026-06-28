import { ReactNode } from 'react';
import { Martini } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AISummaryCardProps {
  /** Defaults to "AI Summary". Use "Joe Says" for Joe-authored content. */
  title?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Emerald-tinted AI panel — the "AI Summary" / "Joe Says" surface in the
 * mockups. Subtle emerald wash + gold martini mark to signal AI-generated
 * content, distinct from the plain white SectionCard.
 */
export function AISummaryCard({ title = 'AI Summary', actions, className, children }: AISummaryCardProps) {
  return (
    <section className={cn(
      'rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.06] to-accent/[0.04] shadow-sm overflow-hidden',
      className,
    )}>
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-primary/10">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
            <Martini className="h-3.5 w-3.5 text-accent" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </header>
      <div className="p-5 text-sm leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}
