import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { DateRangePicker, defaultDashboardRange, type DashboardRange } from '@/components/dashboard/DateRangePicker';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { DashboardTasks } from '@/components/tasks/DashboardTasks';
import { WeekCalendar } from '@/components/dashboard/WeekCalendar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { AddCandidateDialog } from '@/components/candidates/AddCandidateDialog';
import { AddJobDialog } from '@/components/jobs/AddJobDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { useDashboardMetrics, useTeamMembers } from '@/hooks/useData';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Briefcase, Users, Calendar, FileText, Target, Mail,
  Plus, Martini, User, ChevronDown, ChevronUp,
  Building, Send, Award, XCircle, Filter,
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
  const cand = (sendOut.candidate ?? sendOut.candidates) as any;
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
  const { user } = useAuth();
  const [range, setRange]    = useState<DashboardRange>(() => defaultDashboardRange());
  const [ownerScope, setOwnerScope] = useState<string>('all'); // 'all' | 'me' | <user_id>
  const ownerUserId =
    ownerScope === 'all' ? null :
    ownerScope === 'me'  ? (user?.id ?? null) :
    ownerScope;
  const { data: metrics, isLoading } = useDashboardMetrics(range, ownerUserId);
  const { data: team = [] } = useTeamMembers();

  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  // 6-stage funnel — one card per stage table.
  const pitched     = m?.pitchedCount   ?? 0;
  const sendOuts    = m?.sendOutCount   ?? 0;
  const submissions = m?.submittedCount ?? 0;
  const interviews  = m?.interviewCount ?? 0;
  const offers      = m?.offerCount     ?? 0;
  const rejections  = m?.rejectedCount  ?? 0;

  // Person-level statuses
  const newPeople    = m?.newCount         ?? 0;
  const reachedOut   = m?.reachedOutCount  ?? 0;
  const engaged      = m?.engagedCount     ?? 0;

  const engagedList   = m?.engagedList   ?? [];
  const sendOutList   = m?.sendOutList   ?? [];
  const interviewList = m?.interviewList ?? [];

  const ownerLabel =
    ownerScope === 'all' ? 'Whole Team' :
    ownerScope === 'me'  ? 'Me' :
    team.find((t: any) => t.id === ownerScope)?.full_name || 'User';

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
              <Martini className="h-7 w-7 text-gold" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">{getGreeting()}, {displayName}</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isLoading ? 'Loading your stats…' : (
                  <>
                    <span className="font-semibold text-foreground">{m?.activeJobs ?? 0} active jobs</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{engaged} engaged</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{sendOuts} send out{sendOuts !== 1 ? 's' : ''}</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{interviews} interview{interviews !== 1 ? 's' : ''}</span>
                    {' · '}
                    <span className="font-semibold text-foreground">{offers} offer{offers !== 1 ? 's' : ''}</span>
                    {' · '}
                    <span className="text-muted-foreground/80">{range.label.toLowerCase()} · {ownerLabel.toLowerCase()}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-gold/5 blur-2xl" />
          <div className="absolute -right-2 -bottom-8 h-24 w-24 rounded-full bg-accent/5 blur-xl" />
        </div>

        {/* Date range + owner filter */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <DateRangePicker value={range} onChange={setRange} />
            <Select value={ownerScope} onValueChange={setOwnerScope}>
              <SelectTrigger className="w-[180px] h-9">
                <Filter className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Filter by user" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Whole Team</SelectItem>
                {user?.id && <SelectItem value="me">Me ({displayName})</SelectItem>}
                {team.filter((t: any) => t.id !== user?.id).map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>{t.full_name || t.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="text-xs text-muted-foreground">
            {format(range.from, 'MMM d, yyyy')} → {format(range.to, 'MMM d, yyyy')}
          </span>
        </div>

        {/* ── Person status (3 cards, click → People filtered by status) ─ */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-foreground">People — {range.label}</h2>
            <span className="text-xs text-muted-foreground">Click any card to drill in</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricCard label="New"         value={isLoading ? '…' : newPeople}  icon={<Users className="h-5 w-5" />}      onClick={() => navigate('/people?status=new')} />
            <MetricCard label="Reached Out" value={isLoading ? '…' : reachedOut} icon={<Send className="h-5 w-5" />}       onClick={() => navigate('/people?status=reached_out')} />
            <MetricCard label="Engaged"     value={isLoading ? '…' : engaged}    icon={<User className="h-5 w-5" />} highlight onClick={() => navigate('/people?status=engaged')} />
          </div>
        </div>

        {/* ── 6-stage pipeline funnel (click → Send Outs by stage) ─── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-foreground">Pipeline Funnel — {range.label}</h2>
            <span className="text-xs text-muted-foreground">Click any stage to open Send Outs</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <MetricCard label="Pitch"       value={isLoading ? '…' : pitched}     icon={<Target className="h-5 w-5" />}     onClick={() => navigate('/send-outs?stage=pitch')} />
            <MetricCard label="Send Out"    value={isLoading ? '…' : sendOuts}    icon={<FileText className="h-5 w-5" />}   onClick={() => navigate('/send-outs?stage=sent')} />
            <MetricCard label="Submission"  value={isLoading ? '…' : submissions} icon={<Send className="h-5 w-5" />}       onClick={() => navigate('/send-outs?stage=submitted')} />
            <MetricCard label="Interview"   value={isLoading ? '…' : interviews}  icon={<Calendar className="h-5 w-5" />} highlight onClick={() => navigate('/send-outs?stage=interviewing')} />
            <MetricCard label="Offer"       value={isLoading ? '…' : offers}      icon={<Award className="h-5 w-5" />} highlight onClick={() => navigate('/send-outs?stage=offer')} />
            <MetricCard label="Rejection"   value={isLoading ? '…' : rejections}  icon={<XCircle className="h-5 w-5" />}    onClick={() => navigate('/send-outs?stage=rejected')} />
          </div>
        </div>

        {/* ── THE THREE LISTS ───────────────────────────────────────── */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">
            {range.label} — Detail
          </h2>

          {/* Engaged */}
          <ListPanel
            title="Engaged"
            count={engagedList.length}
            icon={<FileText className="h-4 w-4" />}
            accentColor="bg-indigo-500/10 text-indigo-400"
            defaultOpen={engagedList.length > 0}
          >
            {engagedList.map((c: any) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                sub={c.updated_at ? `Updated ${format(new Date(c.updated_at), 'MMM d, yyyy')}` : undefined}
                onClick={() => navigate(`/candidates/${c.id}`)}
              />
            ))}
          </ListPanel>

          {/* Send Outs */}
          <ListPanel
            title="Send Outs"
            count={sendOutList.length}
            icon={<Send className="h-4 w-4" />}
            accentColor="bg-blue-500/10 text-blue-400"
            defaultOpen={sendOutList.length > 0}
          >
            {sendOutList.map((so: any) => {
              const date = so.sent_to_client_at || so.updated_at;
              return (
                <SendOutRow
                  key={so.id}
                  sendOut={so}
                  dateLabel={date ? `${so.stage === 'sent' ? 'Sent' : 'Updated'} ${format(new Date(date), 'MMM d, yyyy')}` : undefined}
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

        {/* ── This Week Calendar ────────────────────────────────────── */}
        <WeekCalendar />

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
