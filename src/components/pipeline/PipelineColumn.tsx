import { cn } from '@/lib/utils';
import type { JobStage, CandidateStage } from '@/types';

interface PipelineColumnProps<T> {
  title: string;
  count: number;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  stageColor?: string;
}

export function PipelineColumn<T>({ 
  title, 
  count, 
  items, 
  renderItem,
  stageColor = 'bg-muted'
}: PipelineColumnProps<T>) {
  return (
    <div className="flex flex-col min-w-[280px] max-w-[300px]">
      <div className="flex items-center justify-between px-3 py-2 rounded-t-lg bg-secondary border border-border border-b-0">
        <div className="flex items-center gap-2">
          <div className={cn('h-2 w-2 rounded-full', stageColor)} />
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="flex-1 space-y-2 rounded-b-lg border border-border bg-card/30 p-2 min-h-[200px]">
        {items.map((item, i) => (
          <div key={i} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
            {renderItem(item)}
          </div>
        ))}
        {items.length === 0 && (
          <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
            No items
          </div>
        )}
      </div>
    </div>
  );
}

// Job stage colors
export const jobStageColors: Record<JobStage, string> = {
  warm: 'bg-stage-warm',
  hot: 'bg-stage-hot',
  interviewing: 'bg-stage-interview',
  offer: 'bg-stage-offer',
  win: 'bg-[#1C3D2E]',
  declined: 'bg-destructive',
  lost: 'bg-[#DC2626]',
  on_hold: 'bg-stage-hold',
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
