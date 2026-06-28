import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SegmentedNav } from '@/components/layout/SegmentedNav';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format, isToday, isPast } from 'date-fns';
import { CalendarClock, Briefcase, Loader2, ChevronRight, Plus, CalendarCheck, ClipboardList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatStrip } from '@/components/shared/StatStrip';
import { cn } from '@/lib/utils';
import { InterviewDetail } from '@/components/interviews/InterviewDetail';
import { NewInterviewDialog } from '@/components/interviews/NewInterviewDialog';

type Filter = 'upcoming' | 'to_schedule' | 'completed' | 'all';

/**
 * Interviews — the Planner section for managing interviews. Rows are created
 * automatically when a candidate reaches the interview stage on a send-out
 * (lib/interviewWorkflow.ts); here a recruiter schedules them, records who the
 * candidate is meeting, and captures prep + debrief notes (InterviewDetail).
 */
export default function Interviews() {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [newOpen, setNewOpen] = useState(false);
  const [searchParams] = useSearchParams();
  // Deep-link: /interviews?interview=<id> opens that interview (e.g. from a send-out).
  useEffect(() => {
    const pid = searchParams.get('interview');
    if (pid) setSelected(pid);
  }, [searchParams]);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['interviews'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(`id, scheduled_at, end_at, stage, round, interview_type, interviewer_name, location, meeting_link,
          completed_at, cancelled_at, outcome, debrief_notes, candidate_id, job_id,
          candidate:people!candidate_id(id, full_name, first_name, last_name, current_title, current_company),
          jobs(id, title, company_name)`)
        .order('scheduled_at', { ascending: true, nullsFirst: true });
      if (error) throw error;
      return data as any[];
    },
  });

  const groups = useMemo(() => {
    const active = rows.filter((r) => !r.cancelled_at);
    const toSchedule = active.filter((r) => !r.scheduled_at && !r.completed_at);
    const upcoming = active.filter((r) => r.scheduled_at && !r.completed_at && !isPast(new Date(r.scheduled_at)));
    const completedOrPast = active.filter((r) => r.completed_at || (r.scheduled_at && isPast(new Date(r.scheduled_at)) && !r.completed_at));
    return { toSchedule, upcoming, completedOrPast };
  }, [rows]);

  const sections = useMemo(() => {
    if (filter === 'to_schedule') return [{ title: 'To be scheduled', items: groups.toSchedule }];
    if (filter === 'completed') return [{ title: 'Completed / Past', items: groups.completedOrPast }];
    if (filter === 'upcoming') return [{ title: 'Upcoming', items: groups.upcoming }];
    return [
      { title: 'To be scheduled', items: groups.toSchedule },
      { title: 'Upcoming', items: groups.upcoming },
      { title: 'Completed / Past', items: groups.completedOrPast },
    ];
  }, [filter, groups]);

  const total = groups.toSchedule.length + groups.upcoming.length + groups.completedOrPast.length;

  return (
    <MainLayout>
      <PageHeader
        title="Interviews"
        description={`${total} interview${total !== 1 ? 's' : ''}`}
        icon={<CalendarCheck />}
        actions={
          <Button variant="gold" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Interview
          </Button>
        }
      >
        <SegmentedNav items={[
          { label: 'Calendar', href: '/calendar' },
          { label: "To-Do's", href: '/tasks' },
          { label: 'Interviews', href: '/interviews' },
        ]} />
      </PageHeader>

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-6">
        <StatStrip
          items={[
            { label: 'To schedule', value: groups.toSchedule.length },
            { label: 'Upcoming', value: groups.upcoming.length },
            { label: 'Completed / Past', value: groups.completedOrPast.length },
          ]}
        />

        <div className="flex items-center gap-2">
          {(([['upcoming', 'Upcoming'], ['to_schedule', 'To schedule'], ['completed', 'Completed'], ['all', 'All']]) as [Filter, string][]).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                'px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors',
                filter === k ? 'bg-primary text-primary-foreground border-primary' : 'border-card-border bg-card text-muted-foreground hover:text-foreground hover:border-primary/30',
              )}
            >
              {l}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : total === 0 ? (
          <div className="rounded-2xl border border-dashed border-card-border bg-card shadow-sm p-12 text-center">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <CalendarClock className="h-6 w-6" />
            </span>
            <p className="font-display text-base font-semibold text-foreground">No interviews yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              When a candidate moves to the Interview stage on a send-out, an interview is created here automatically — then add the date, who they're meeting, and notes.
            </p>
          </div>
        ) : (
          sections.map((g) => g.items.length > 0 && (
            <div key={g.title} className="space-y-2.5">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h3>
                <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">{g.items.length}</span>
              </div>
              <div className="space-y-2.5">
                {g.items.map((r: any) => <InterviewRow key={r.id} row={r} onOpen={() => setSelected(r.id)} />)}
              </div>
            </div>
          ))
        )}
      </div>

      <InterviewDetail interviewId={selected} open={!!selected} onOpenChange={(v) => { if (!v) setSelected(null); }} onNavigate={(nid) => setSelected(nid)} />
      <NewInterviewDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => setSelected(id)} />
    </MainLayout>
  );
}

function InterviewRow({ row, onOpen }: { row: any; onOpen: () => void }) {
  const cand = row.candidate;
  const name = cand?.full_name || `${cand?.first_name ?? ''} ${cand?.last_name ?? ''}`.trim() || 'Candidate';
  const job = row.jobs;
  const when = row.scheduled_at ? new Date(row.scheduled_at) : null;
  const today = when ? isToday(when) : false;

  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-2xl border border-card-border bg-card shadow-sm p-4 hover:border-primary/30 hover:bg-muted/30 transition-all group"
    >
      <div className="flex items-center gap-3">
        <div className={cn(
          'flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl border',
          when ? 'border-accent/20 bg-accent/10 text-accent' : 'border-card-border bg-muted text-muted-foreground',
        )}>
          {when ? (
            <>
              <span className="text-[9px] uppercase leading-none opacity-80">{format(when, 'MMM')}</span>
              <span className="text-base font-bold leading-tight tabular-nums">{format(when, 'd')}</span>
            </>
          ) : <CalendarClock className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-foreground truncate">{name}</p>
            {today && <Badge variant="secondary" className="text-[9px] bg-accent/15 text-accent border-accent/30">Today</Badge>}
            {row.round > 1 && <Badge variant="secondary" className="text-[9px]">Round {row.round}</Badge>}
            {row.completed_at && <Badge variant="secondary" className="text-[9px] bg-success/10 text-success border-success/20">Completed</Badge>}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {job?.title && <span className="inline-flex items-center gap-1"><Briefcase className="h-3 w-3" /> {job.title}</span>}
            {job?.company_name && <> · {job.company_name}</>}
          </p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {when ? format(when, 'EEE, MMM d · h:mm a') : 'Not scheduled'}
            {row.interviewer_name && <> · with {row.interviewer_name}</>}
            {row.interview_type && <> · {row.interview_type}</>}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
  );
}
