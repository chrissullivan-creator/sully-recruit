import { format } from 'date-fns';
import { Check, CalendarClock, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useInterviewStages,
  pickInterviews,
  roundStatus,
  type InterviewLite,
} from '@/lib/queries/interviews';

const TYPE_LABEL: Record<string, string> = {
  phone_screen: 'Phone screen',
  video: 'Video',
  onsite: 'Onsite',
  technical: 'Technical',
  case_study: 'Case study',
  partner: 'Partner',
  final: 'Final',
};

/**
 * Compact, horizontally-scrollable strip of interview rounds for a single
 * send-out (or candidate+job). Each chip says which round it is and whether
 * it's completed, scheduled (with date), or still to be scheduled — so a
 * candidate/job card in the Interview stage shows exactly where things stand.
 */
export function InterviewStageStrip({
  sendOutId,
  candidateId,
  jobId,
  className,
  onOpen,
}: {
  sendOutId?: string | null;
  candidateId?: string | null;
  jobId?: string | null;
  className?: string;
  onOpen?: (interviewId: string) => void;
}) {
  const { data: all = [] } = useInterviewStages();
  const rounds = pickInterviews(all, { sendOutId, candidateId, jobId });
  if (rounds.length === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {rounds.map((iv) => (
        <RoundChip key={iv.id} iv={iv} onOpen={onOpen} />
      ))}
    </div>
  );
}

function RoundChip({ iv, onOpen }: { iv: InterviewLite; onOpen?: (id: string) => void }) {
  const status = roundStatus(iv);
  const type = iv.interview_type ? TYPE_LABEL[iv.interview_type] ?? iv.interview_type : null;
  const when = iv.scheduled_at ? new Date(iv.scheduled_at) : null;

  const detail =
    status === 'completed'
      ? iv.outcome && iv.outcome !== 'pending'
        ? iv.outcome
        : 'completed'
      : status === 'scheduled' && when
        ? format(when, 'MMM d')
        : 'to schedule';

  const styles: Record<string, string> = {
    completed: 'bg-success/10 text-success border-success/25',
    scheduled: 'bg-info/10 text-info border-info/25',
    to_schedule: 'bg-muted text-muted-foreground border-border',
  };
  const Icon = status === 'completed' ? Check : status === 'scheduled' ? CalendarClock : Clock;

  return (
    <button
      type="button"
      onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(iv.id); } : undefined}
      disabled={!onOpen}
      title={type ? `Round ${iv.round ?? 1} · ${type}` : `Round ${iv.round ?? 1}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize transition-colors',
        styles[status],
        onOpen && 'hover:brightness-95 cursor-pointer',
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      <span className="font-semibold">R{iv.round ?? 1}</span>
      <span className="opacity-80">· {detail}</span>
    </button>
  );
}
