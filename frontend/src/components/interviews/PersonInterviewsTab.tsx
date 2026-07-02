import { useState } from 'react';
import { format, isToday, isPast } from 'date-fns';
import { CalendarClock, Briefcase, Loader2, ChevronRight, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { InterviewDetail } from '@/components/interviews/InterviewDetail';
import { PersonLink, JobLink, CompanyLink } from '@/components/shared/EntityLinks';
import {
  useCandidateInterviews,
  useCompanyInterviews,
  useJobInterviews,
  roundStatus,
  type InterviewLite,
} from '@/lib/queries/interviews';

/**
 * Interviews tab shared by Candidate detail (candidateId) and Client/Contact
 * detail (companyId — every interview across that company's jobs). Lists rounds
 * with their status and opens the full InterviewDetail on click.
 */
export function PersonInterviewsTab({
  candidateId,
  companyId,
  jobIds = [],
  showCandidate = false,
}: {
  candidateId?: string | null;
  companyId?: string | null;
  jobIds?: string[];
  /** Show the candidate name on each row (client view, where rows span people). */
  showCandidate?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const candidateQ = useCandidateInterviews(candidateId ?? null);
  const jobQ = useJobInterviews(jobIds);
  const companyQ = useCompanyInterviews(companyId ?? null);
  const { data: rows = [], isLoading } = candidateId ? candidateQ : jobIds.length > 0 ? jobQ : companyQ;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-card-border bg-card p-10 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <CalendarClock className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-foreground">No interviews yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Interviews appear here when a candidate reaches the interview stage on a send-out.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((iv) => (
        <PersonInterviewRow key={iv.id} iv={iv} showCandidate={showCandidate} onOpen={() => setSelected(iv.id)} />
      ))}
      <InterviewDetail
        interviewId={selected}
        open={!!selected}
        onOpenChange={(v) => { if (!v) setSelected(null); }}
        onNavigate={(nid) => setSelected(nid)}
      />
    </div>
  );
}

function PersonInterviewRow({
  iv,
  showCandidate,
  onOpen,
}: {
  iv: InterviewLite;
  showCandidate: boolean;
  onOpen: () => void;
}) {
  const status = roundStatus(iv);
  const when = iv.scheduled_at ? new Date(iv.scheduled_at) : null;
  const today = when ? isToday(when) : false;
  const overdue = when ? isPast(when) && status !== 'completed' : false;
  const job = iv.jobs;

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      className="group w-full cursor-pointer rounded-2xl border border-card-border bg-card p-3.5 text-left shadow-sm transition-all hover:border-primary/30 hover:bg-muted/30"
    >
      <div className="flex items-center gap-3">
        <div className={cn(
          'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl border',
          status === 'completed' ? 'border-success/20 bg-success/10 text-success'
            : when ? 'border-accent/20 bg-accent/10 text-accent'
            : 'border-card-border bg-muted text-muted-foreground',
        )}>
          {status === 'completed' ? <Check className="h-4 w-4" />
            : when ? (
              <>
                <span className="text-[8px] uppercase leading-none opacity-80">{format(when, 'MMM')}</span>
                <span className="text-sm font-bold leading-tight tabular-nums">{format(when, 'd')}</span>
              </>
            ) : <CalendarClock className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {showCandidate && iv.candidate?.full_name && (
              <PersonLink
                id={iv.candidate_id}
                name={iv.candidate.full_name}
                stopPropagation
                className="text-sm font-medium text-foreground truncate"
              />
            )}
            <Badge variant="secondary" className="text-[9px]">Round {iv.round ?? 1}</Badge>
            {iv.interview_type && <span className="text-[11px] text-muted-foreground capitalize">{iv.interview_type.replace(/_/g, ' ')}</span>}
            {today && <Badge variant="secondary" className="text-[9px] bg-accent/15 text-accent border-accent/30">Today</Badge>}
            {status === 'completed' && <Badge variant="secondary" className="text-[9px] bg-success/10 text-success border-success/20">Completed</Badge>}
            {overdue && <Badge variant="secondary" className="text-[9px] bg-warning/10 text-warning border-warning/20">Needs debrief</Badge>}
          </div>
          {job?.title && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Briefcase className="h-3 w-3" />
                <JobLink id={iv.job_id} title={job.title} stopPropagation className="text-muted-foreground" />
              </span>
              {job.company_name && <> · <CompanyLink name={job.company_name} stopPropagation className="text-muted-foreground" /></>}
            </p>
          )}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {when ? format(when, 'EEE, MMM d · h:mm a') : 'Not scheduled'}
            {iv.interviewer_name && <> · with {iv.interviewer_name}</>}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </div>
  );
}
