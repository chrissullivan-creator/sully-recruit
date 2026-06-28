import { ReactNode, useState } from 'react';
import { Martini } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AskJoePanel } from '@/components/joe/AskJoePanel';

interface PageHeaderProps {
  title: ReactNode;
  /** Optional count rendered as a pill beside the title (lists). */
  count?: number | string;
  /** Right-aligned actions cluster (search, filters, view toggle, primary Add). */
  actions?: ReactNode;
  /** Optional line under the title. */
  subtitle?: ReactNode;
  /** Show the gold "Ask Joe" trigger pinned far right. Default true. */
  joe?: boolean;
  className?: string;
}

/**
 * PageHeader — the standard list/detail page header. Title + count pill on the
 * left, an `actions` cluster on the right, and the existing Ask Joe launcher
 * pinned far right (gold). This renders inside page content only — it never
 * touches or affects the sidebar/layout chrome.
 */
export function PageHeader({ title, count, actions, subtitle, joe = true, className }: PageHeaderProps) {
  const [joeOpen, setJoeOpen] = useState(false);

  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground truncate">{title}</h1>
          {count !== undefined && count !== null && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {joe && (
          <>
            <button
              type="button"
              onClick={() => setJoeOpen(true)}
              title="Ask Joe (⌘J)"
              aria-label="Ask Joe"
              className="group inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3 text-sm font-semibold text-accent-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <Martini className="h-4 w-4" />
              <span className="hidden sm:inline">Ask Joe</span>
            </button>
            <AskJoePanel open={joeOpen} onClose={() => setJoeOpen(false)} />
          </>
        )}
      </div>
    </div>
  );
}
