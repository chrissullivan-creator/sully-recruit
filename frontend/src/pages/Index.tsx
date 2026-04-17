import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { DashboardTasks } from '@/components/tasks/DashboardTasks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddCandidateDialog } from '@/components/candidates/AddCandidateDialog';
import { AddJobDialog } from '@/components/jobs/AddJobDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { useDashboardMetrics } from '@/hooks/useData';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Briefcase, Users, Calendar, FileText, Target, Mail,
  Plus, Sparkles, User, ChevronDown, ChevronUp,
  Building, Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

// ── Shared list item for a candidate row ─────────────────────────────
const CandidateRow = ({
  candidate,
  sub,
  onClick,
}: {
  candidate: any;
  sub?: string;
  onClick?: () => void;
}) => {
  const name = candidate.full_name ||
    `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`.trim() || '—';
  const initials = (
    (candidate.first_name?.[0] ?? '') + (candidate.last_name?.[0] ?? '')
  ).toUpperCase() || name[0]?.toUpperCase() || '?';
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/60 transition-colors text-left group"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground group-hover:text-accent transition-colors truncate">{name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {candidate.current_title ?? ''}
          {candidate.current_title && candidate.current_company ? ' · ' : ''}
          {candidate.current_company ?? ''}
        </p>
        {sub && <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">{sub}</p>}
      </div>
    </button>
  );
};

// ── List item for a send_out row (sent / interview) ──────────────────
const SendOutRow = ({
  sendOut,
  dateLabel,
  onClick,
}: {
  sendOut: any;
  dateLabel?: string | null;
  onClick?: () => void;
}) => {
  const cand = sendOut.candidates as any;
  const job  = sendOut.jobs as any;
  const name = cand?.full_name ||
    `${cand?.first_name ?? ''} ${cand?.last_name ?? ''}`.trim() || '—';
  const initials = (
    (cand?.first_name?.[0] ?? '') + (cand?.last_name?.[0] ?? '')
  ).toUpperCase() || name[0]?.toUpperCase() || '?';
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/60 transition-colors text-left group"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground group-hover:text-accent transition-colors truncate">{name}</p>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Building className="h-3 w-3 shrink-0" />
          <span className="truncate">{job?.title ?? '—'}{job?.company_name ? ` · ${job.company_name}` : ''}</span>
        </div>
        {dateLabel && (
          <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">{dateLabel}</p>
        )}
      </div>
    </button>
  );
};

// ── Collapsible panel with count badge ───────────────────────────────
const ListPanel = ({
  title,
  count,
  icon,
  accentColor,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  accentColor: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', accentColor)}>
            {icon}
          </span>
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <span className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums',
            accentColor
          )}>
            {count}
          </span>
        </div>
        {open
          ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
          : <ChevronDown className="h-4 w-4 text-muted-foreground" />
        }
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border/50">
          {count === 0
            ? <p className="px-4 py-3 text-sm text-muted-foreground">None {title.toLowerCase()} this period.</p>
            : children
          }
        </div>
      )}
    </div>
  );
};

// ── Main Dashboard ────────────────────────────────────────────────────
const Dashboard = () => {
  const { data: metrics, isLoading } = useDashboardMetrics();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  const [addCandidateOpen, setAddCandidateOpen]   = useState(false);
  const [addJobOpen, setAddJobOpen]               = useState(false);
  const [addContactOpen, setAddContactOpen]       = useState(false);
  const [creatingSequence, setCreatingSequence]   = useState(false);

  const handleCreateSequence = async () => {
    setCreatingSequence(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: seq, error } = await supabase
        .from('sequences')
        .insert({ name: 'Untitled Sequence', channel: 'email', status: 'draft', stop_on_reply: true, created_by: userId } as any)
        .select('id')
        .single();
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      navigate(`/sequences/${seq.id}/edit`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create sequence');
    } finally {
      setCreatingSequence(false);
    }
  };

  const displayName = user?.user_metadata?.display_name?.split(' ')[0] || 'there';
  const m = metrics;

  // Period-aware counts
  const candidates      = period === 'week' ? m?.weekCandidates      : m?.monthCandidates;
  const myCandidates    = period === 'week' ? m?.myWeekCandidates    : m?.myMonthCandidates;
  const newCount        = period === 'week' ? m?.weekNew             : m?.monthNew;
  const contacted       = period === 'week' ? m?.weekContacted       : m?.monthContacted;
  const pitched         = period === 'week' ? m?.weekPitched         : m?.monthPitched;
  const sendOut         = period === 'week' ? m?.weekSendOut         : m?.monthSendOut;
  const interviewing    = period === 'week' ? m?.weekInterviewing    : m?.monthInterviewing;
  const offer           = period === 'week' ? m?.weekOffer           : m?.monthOffer;
  const backOfResume    = period === 'week' ? m?.weekBackOfResume    : m?.monthBackOfResume;
  const sentCount       = period === 'week' ? m?.weekSentCount       : m?.monthSentCount;
  const interviewCount  = period === 'week' ? m?.weekInterviewCount  : m?.monthInterviewCount;

  // Period-aware lists
  const borList       = period === 'week' ? (m?.weekBackOfResumeList  ?? []) : (m?.backOfResumeList  ?? []);
  const sentList      = period === 'week' ? (m?.weekSentList          ?? []) : (m?.sentList          ?? []);
  const interviewList = period === 'week' ? (m?.weekInterviewList     ?? []) : (m?.interviewList     ?? []);

  return (
    <MainLayout>
      <PageHeader
        title="Dashboard"
        description="Welcome back. Here's what's happening today."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="gold"><Plus className="h-4 w-4" />Quick Add</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setAddContactOpen(true)}><Plus className="h-4 w-4 mr-2" />Add Contact</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddCandidateOpen(true)}><Users className="h-4 w-4 mr-2" />Add Candidate</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddJobOpen(true)}><Briefcase className="h-4 w-4 mr-2" />Add Job</DropdownMenuItem>
              <DropdownMenuItem onClick={handleCreateSequence} disabled={creatingSequence}><Mail className="h-4 w-4 mr-2" />Add Sequence</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="p-8 space-y-8">

        {/* Welcome Banner */}
        <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-sidebar via-card to-card p-6">
          <div className="relative z-10 flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gold/10 border border-gold/20">
              <Sparkles className="h-7 w-7 text-gold" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">{getGreeting()}, {displayName}</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isLoading ? 'Loading your stats…' : (
                  <>
                    <span className="font-semibold text-foreground">{m?.activeJobs ?? 0} active jobs</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{backOfResume ?? 0} back of resume</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{sentCount ?? 0} sent</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{interviewCount ?? 0} interview{interviewCount !== 1 ? 's' : ''}</span>
                    {' '}{period === 'week' ? 'this week' : 'this month'}
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-gold/5 blur-2xl" />
          <div className="absolute -right-2 -bottom-8 h-24 w-24 rounded-full bg-accent/5 blur-xl" />
        </div>

        {/* Period Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPeriod('week')}
            className={cn('px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
              period === 'week' ? 'bg-accent text-white' : 'bg-muted text-muted-foreground hover:text-foreground')}
          >
            This Week
          </button>
          <button
            onClick={() => setPeriod('month')}
            className={cn('px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
              period === 'month' ? 'bg-accent text-white' : 'bg-muted text-muted-foreground hover:text-foreground')}
          >
            This Month
          </button>
        </div>

        {/* ── Primary pipeline counts ────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <MetricCard label="Active Jobs"    value={isLoading ? '…' : (m?.activeJobs ?? 0)}   icon={<Briefcase className="h-5 w-5" />} />
          <MetricCard label="My Candidates"  value={isLoading ? '…' : (myCandidates ?? 0)}    icon={<User className="h-5 w-5" />} />
          <MetricCard label="New"            value={isLoading ? '…' : (newCount ?? 0)}         icon={<Users className="h-5 w-5" />} />
          <MetricCard label="Contacted"      value={isLoading ? '…' : (contacted ?? 0)}        icon={<Mail className="h-5 w-5" />} />
          <MetricCard label="Pitched"        value={isLoading ? '…' : (pitched ?? 0)}          icon={<Target className="h-5 w-5" />} />
        </div>

        {/* ── Key production metrics (the 3 you asked for) ─────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            label="Back of Resume"
            value={isLoading ? '…' : (backOfResume ?? 0)}
            icon={<FileText className="h-5 w-5" />}
            highlight
          />
          <MetricCard
            label="Sent to Client"
            value={isLoading ? '…' : (sentCount ?? 0)}
            icon={<Send className="h-5 w-5" />}
            highlight
          />
          <MetricCard
            label="Interviews"
            value={isLoading ? '…' : (interviewCount ?? 0)}
            icon={<Calendar className="h-5 w-5" />}
            highlight
          />
        </div>

        {/* ── Secondary pipeline counts ─────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <MetricCard label="Send Outs"   value={isLoading ? '…' : (sendOut ?? 0)}      icon={<FileText className="h-5 w-5" />} />
          <MetricCard label="Interviewing (cand)" value={isLoading ? '…' : (interviewing ?? 0)} icon={<Calendar className="h-5 w-5" />} />
          <MetricCard label="Offers Out"  value={isLoading ? '…' : (offer ?? 0)}        icon={<Briefcase className="h-5 w-5" />} />
        </div>

        {/* ── THE THREE LISTS ───────────────────────────────────────── */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">
            {period === 'week' ? 'This Week' : 'This Month'} — Detail
          </h2>

          {/* Back of Resume */}
          <ListPanel
            title="Back of Resume"
            count={borList.length}
            icon={<FileText className="h-4 w-4" />}
            accentColor="bg-indigo-500/10 text-indigo-400"
            defaultOpen={borList.length > 0}
          >
            {borList.map((c: any) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                sub={c.updated_at ? `Updated ${format(new Date(c.updated_at), 'MMM d, yyyy')}` : undefined}
                onClick={() => navigate(`/candidates/${c.id}`)}
              />
            ))}
          </ListPanel>

          {/* Sent to Client */}
          <ListPanel
            title="Sent to Client"
            count={sentList.length}
            icon={<Send className="h-4 w-4" />}
            accentColor="bg-blue-500/10 text-blue-400"
            defaultOpen={sentList.length > 0}
          >
            {sentList.map((so: any) => {
              const sentDate = so.sent_to_client_at || so.updated_at;
              return (
                <SendOutRow
                  key={so.id}
                  sendOut={so}
                  dateLabel={sentDate ? `Sent ${format(new Date(sentDate), 'MMM d, yyyy')}` : undefined}
                  onClick={() => navigate(`/candidates/${so.candidate_id}`)}
                />
              );
            })}
          </ListPanel>

          {/* Interviews */}
          <ListPanel
            title="Interviews"
            count={interviewList.length}
            icon={<Calendar className="h-4 w-4" />}
            accentColor="bg-emerald-500/10 text-emerald-400"
            defaultOpen={interviewList.length > 0}
          >
            {interviewList.map((so: any) => {
              const intDate = so.interview_at || so.updated_at;
              return (
                <SendOutRow
                  key={so.id}
                  sendOut={so}
                  dateLabel={intDate ? `Interview ${format(new Date(intDate), 'MMM d, h:mm a')}` : undefined}
                  onClick={() => navigate(`/candidates/${so.candidate_id}`)}
                />
              );
            })}
          </ListPanel>
        </div>

        {/* ── Tasks + Quick Actions ─────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <DashboardTasks />
          </div>
          <div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Quick Actions</h2>
              <div className="space-y-2">
                <Button variant="outline" className="w-full justify-start" onClick={() => setAddContactOpen(true)}><Plus className="h-4 w-4 mr-2" />Add Contact</Button>
                <Button variant="outline" className="w-full justify-start" onClick={() => setAddCandidateOpen(true)}><Users className="h-4 w-4 mr-2" />Add Candidate</Button>
                <Button variant="outline" className="w-full justify-start" onClick={() => setAddJobOpen(true)}><Briefcase className="h-4 w-4 mr-2" />Add Job</Button>
                <Button variant="outline" className="w-full justify-start" onClick={handleCreateSequence} disabled={creatingSequence}><Mail className="h-4 w-4 mr-2" />Add Sequence</Button>
              </div>
            </div>
          </div>
        </div>

        {/* ── Job Pipeline ─────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Job Pipeline</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/jobs')}>View All Jobs</Button>
          </div>
          <JobPipeline />
        </section>
      </div>

      <AddCandidateDialog open={addCandidateOpen} onOpenChange={setAddCandidateOpen} />
      <AddJobDialog       open={addJobOpen}       onOpenChange={setAddJobOpen} />
      <AddContactDialog   open={addContactOpen}   onOpenChange={setAddContactOpen} />
    </MainLayout>
  );
};

export default Dashboard;
