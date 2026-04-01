import { cn } from '@/lib/utils';

interface FunnelStage {
  label: string;
  value: number;
  color: string;
}

interface Props {
  stages: FunnelStage[];
}

export function ConversionFunnel({ stages }: Props) {
  const maxValue = Math.max(...stages.map(s => s.value), 1);

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">Candidate Pipeline Funnel</h2>
      <div className="space-y-3">
        {stages.map((stage, i) => {
          const widthPct = Math.max((stage.value / maxValue) * 100, 8);
          const prevValue = i > 0 ? stages[i - 1].value : null;
          const conversionRate = prevValue && prevValue > 0
            ? Math.round((stage.value / prevValue) * 100)
            : null;

          return (
            <div key={stage.label} className="flex items-center gap-3">
              <div className="w-24 text-xs text-muted-foreground text-right shrink-0">
                {stage.label}
              </div>
              <div className="flex-1 relative">
                <div
                  className={cn('h-8 rounded-md flex items-center px-3 transition-all duration-500', stage.color)}
                  style={{ width: `${widthPct}%` }}
                >
                  <span className="text-xs font-semibold text-white drop-shadow-sm">
                    {stage.value}
                  </span>
                </div>
              </div>
              <div className="w-12 text-right shrink-0">
                {conversionRate !== null ? (
                  <span className="text-[10px] text-muted-foreground">{conversionRate}%</span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground mt-3 text-right">% = conversion from previous stage</p>
    </div>
  );
}
