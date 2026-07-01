import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getQueryErrorMessage } from '@/lib/queryTimeout';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; icon?: LucideIcon };
  className?: string;
  /** Render extra UI below the action button. */
  children?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action, className, children }: EmptyStateProps) {
  const ActionIcon = action?.icon;
  return (
    <div className={cn(
      'rounded-xl border border-dashed border-card-border bg-white py-14 px-6 text-center',
      className,
    )}>
      <div className="mx-auto h-12 w-12 rounded-full bg-emerald-light flex items-center justify-center mb-3">
        <Icon className="h-5 w-5 text-emerald" />
      </div>
      <p className="text-sm font-display font-semibold text-emerald-dark">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">{description}</p>
      )}
      {action && (
        <Button variant="gold" size="sm" onClick={action.onClick} className="mt-4 gap-1.5">
          {ActionIcon && <ActionIcon className="h-3.5 w-3.5" />}
          {action.label}
        </Button>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

interface QueryRetryButtonProps {
  onRetry?: () => void;
  label?: string;
  className?: string;
}

export function QueryRetryButton({ onRetry, label = 'Retry', className }: QueryRetryButtonProps) {
  if (!onRetry) return null;
  return (
    <Button variant="outline" size="sm" onClick={onRetry} className={cn('mt-4 gap-1.5', className)}>
      <RefreshCw className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

interface DataErrorStateProps {
  title?: string;
  description?: string;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function DataErrorState({
  title = 'Data source unavailable',
  description = 'This page could not load its data. Check system status or try again.',
  error,
  onRetry,
  retryLabel = 'Retry',
  className,
}: DataErrorStateProps) {
  const message = getQueryErrorMessage(error);

  return (
    <div
      role="alert"
      className={cn(
        'rounded-xl border border-amber-200 bg-amber-50 py-10 px-6 text-center',
        className,
      )}
    >
      <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center mb-3">
        <AlertTriangle className="h-5 w-5 text-amber-700" />
      </div>
      <p className="text-sm font-display font-semibold text-amber-900">{title}</p>
      <p className="text-xs text-amber-800/80 mt-1 max-w-md mx-auto">{description}</p>
      {message && (
        <p className="text-[11px] text-amber-900/70 mt-2 max-w-md mx-auto truncate" title={message}>
          {message}
        </p>
      )}
      <QueryRetryButton onRetry={onRetry} label={retryLabel} />
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-card-border bg-white p-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-emerald-light/40" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-emerald-light/60 rounded w-1/3" />
              <div className="h-2.5 bg-muted rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="rounded-xl border border-card-border bg-white p-4 animate-pulse space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-gold-bg" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-emerald-light/60 rounded w-2/3" />
              <div className="h-2.5 bg-muted rounded w-1/2" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-2.5 bg-muted rounded w-full" />
            <div className="h-2.5 bg-muted rounded w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-xl border border-card-border bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-card-border bg-page-bg/40 flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-2.5 bg-muted rounded flex-1 max-w-[120px]" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-3 border-b border-card-border last:border-b-0 flex gap-4 items-center animate-pulse">
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className={cn('h-3 bg-muted rounded flex-1', j === 0 ? 'max-w-[140px]' : 'max-w-[100px]')} />
          ))}
        </div>
      ))}
    </div>
  );
}
