import { cn } from '@/lib/utils';
import type { JobStage, CandidateStage } from '@/types';

interface PipelineColumnProps<T> {
  title: string;
  count: number;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  stageColor?: string;
  headerClass?: string;
}

export function PipelineColumn<T>({
  title,
  count,
  items,
  renderItem,
  stageColor = 'bg-muted',
  headerClass,
}: PipelineColumnProps<T>) {
  return (
    <div className="flex flex-col min-w-[280px] max-w-[300px]">
      <div className={cn("flex items-center justify-between px-3 py-2.5 rounded-t-2xl bg-muted/40 border border-card-border border-b-0", headerClass)}>
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn('h-2 w-2 rounded-full shrink-0', stageColor)} />
          <h3 className="text-[13px] font-semibold text-foreground truncate">{title}</h3>
        </div>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-card px-1.5 text-xs font-semibold text-muted-foreground tabular-nums">
          {count}
        </span>
      </div>
      <div className="flex-1 space-y-2 rounded-b-2xl border border-card-border bg-muted/20 p-2 min-h-[200px]">
        {items.map((item, i) => (
          <div key={i} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
            {renderItem(item)}
          </div>
        ))}
        {items.length === 0 && (
          <div className="flex items-center justify-center h-20 text-sm text-muted-foreground/70">
            No items
          </div>
        )}
      </div>
    </div>
  );
}

// Job stage colors
export const jobStageColors: Record<JobStage, string> = {
  lead: 'bg-gray-400',
  hot: 'bg-accent',
  offer_made: 'bg-primary',
  filled: 'bg-emerald-dark',
  closed_lost: 'bg-[#DC2626]',
};

// Candidate stage colors
export const candidateStageColors: Record<CandidateStage, string> = {
  back_of_resume: 'bg-muted-foreground',
  pitch: 'bg-stage-warm',
  send_out: 'bg-stage-warm',
  submitted: 'bg-stage-interview',
  interview: 'bg-stage-interview',
  first_round: 'bg-stage-interview',
  second_round: 'bg-info',
  third_plus_round: 'bg-info',
  offer: 'bg-stage-offer',
  accepted: 'bg-success',
  declined: 'bg-destructive',
  counter_offer: 'bg-warning',
  disqualified: 'bg-muted-foreground',
};
