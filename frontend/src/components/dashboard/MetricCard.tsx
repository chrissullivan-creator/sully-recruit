import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string | number;
  change?: {
    value: number;
    isPositive: boolean;
  };
  icon?: React.ReactNode;
  highlight?: boolean;
  onClick?: () => void;
}

export function MetricCard({ label, value, change, icon, highlight, onClick }: MetricCardProps) {
  const interactive = !!onClick;
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      className={cn(
        'metric-card hover-lift',
        highlight && 'ring-1 ring-accent/30 bg-accent/5',
        interactive && 'cursor-pointer hover:border-accent/40 transition-colors',
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="metric-label">{label}</p>
          <p className="metric-value mt-2">{value}</p>
          {change && (
            <p
              className={cn(
                'mt-1 text-xs font-medium',
                change.isPositive ? 'text-success' : 'text-destructive'
              )}
            >
              {change.isPositive ? '+' : ''}{change.value}% from last week
            </p>
          )}
        </div>
        {icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
