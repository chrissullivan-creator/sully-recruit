import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string | number;
  change?: {
    value: number;
    isPositive: boolean;
  };
  icon?: React.ReactNode;
}

export function MetricCard({ label, value, change, icon }: MetricCardProps) {
  return (
    <div className="metric-card hover-lift group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="metric-label">{label}</p>
          <p className="metric-value mt-2 leading-none">{value}</p>
          {change && (
            <p
              className={cn(
                'mt-2 text-xs font-medium',
                change.isPositive ? 'text-success' : 'text-destructive',
              )}
            >
              {change.isPositive ? '↑' : '↓'} {Math.abs(change.value)}% vs last week
            </p>
          )}
        </div>
        {icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/10 text-gold border border-gold/15 group-hover:bg-gold/15 transition-colors">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
