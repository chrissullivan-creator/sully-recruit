import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { DashboardTasks } from '@/components/tasks/DashboardTasks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  Briefcase,
  Users,
  Calendar,
  FileText,
  Target,
  Mail,
  TrendingUp,
  Plus,
  Sparkles,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const Dashboard = () => {
  const { data: metrics, isLoading } = useDashboardMetrics();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  const [addCandidateOpen, setAddCandidateOpen] = useState(false);
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [creatingSequence, setCreatingSequence] = useState(false);

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
      navigate(`/sequences/${seq.id}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create sequence');
    } finally {
      setCreatingSequence(false);
    }
  };

  const displayName = user?.user_metadata?.display_name?.split(' ')[0] || 'there';

  // Pick the right numbers based on selected period
  const m = metrics;
  const candidates   = period === 'week' ? m?.weekCandidates   : m?.monthCandidates;
  const myCandidates = period === 'week' ? m?.myWeekCandidates : m?.myMonthCandidates;
  const newCount     = period === 'week' ? m?.weekNew          : m?.monthNew;
  const contacted    = period === 'week' ? m?.weekContacted    : m?.monthContacted;
  const pitched      = period === 'week' ? m?.weekPitched      : m?.monthPitched;
  const sendOut      = period === 'week' ? m?.weekSendOut      : m?.monthSendOut;
  const submitted    = period === 'week' ? m?.weekSubmitted    : m?.monthSubmitted;
  const interviewing = period === 'week' ? m?.weekInterviewing : m?.monthInterviewing;
  const offer        = period === 'week' ? m?.weekOffer        : m?.monthOffer;

  return (
    <MainLayout>
      <PageHeader
        title="Dashboard"
        description="Welcome back. Here's what's happening today."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="gold">
                <Plus className="h-4 w-4" />
                Quick Add
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setAddContactOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />Add Contact
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddCandidateOpen(true)}>
                <Users className="h-4 w-4 mr-2" />Add Candidate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddJobOpen(true)}>
                <Briefcase className="h-4 w-4 mr-2" />Add Job
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCreateSequence} disabled={creatingSequence}>
                <Mail className="h-4 w-4 mr-2" />Add Sequence
              </DropdownMenuItem>
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
              <h2 className="text-xl font-bold text-foreground">
                {getGreeting()}, {displayName}
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isLoading ? 'Loading your stats…' : (
                  <>
                    You have <span className="font-semibold text-foreground">{m?.activeJobs ?? 0} active jobs</span> and{' '}
                    <span className="font-semibold text-foreground">{candidates ?? 0} new candidates</span> {period === 'week' ? 'this week' : 'this month'}.
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
            className={cn(
              'px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
              period === 'week'
                ? 'bg-accent text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            This Week
          </button>
          <button
            onClick={() => setPeriod('month')}
            className={cn(
              'px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
              period === 'month'
                ? 'bg-accent text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            This Month
          </button>
        </div>

        {/* Primary Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <MetricCard label="Active Jobs" value={isLoading ? '…' : (m?.activeJobs ?? 0)} icon={<Briefcase className="h-5 w-5" />} />
          <MetricCard label="My Candidates" value={isLoading ? '…' : (myCandidates ?? 0)} icon={<User className="h-5 w-5" />} />
          <MetricCard label="New" value={isLoading ? '…' : (newCount ?? 0)} icon={<Users className="h-5 w-5" />} />
          <MetricCard label="Contacted" value={isLoading ? '…' : (contacted ?? 0)} icon={<Mail className="h-5 w-5" />} />
          <MetricCard label="Pitched" value={isLoading ? '…' : (pitched ?? 0)} icon={<Target className="h-5 w-5" />} />
        </div>

        {/* Pipeline Stage Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Send Outs" value={isLoading ? '…' : (sendOut ?? 0)} icon={<FileText className="h-5 w-5" />} />
          <MetricCard label="Submitted" value={isLoading ? '…' : (submitted ?? 0)} icon={<TrendingUp className="h-5 w-5" />} />
          <MetricCard label="Interviewing" value={isLoading ? '…' : (interviewing ?? 0)} icon={<Calendar className="h-5 w-5" />} />
          <MetricCard label="Offers Out" value={isLoading ? '…' : (offer ?? 0)} icon={<Briefcase className="h-5 w-5" />} />
        </div>

        {/* Tasks + Quick Actions */}
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

        {/* Job Pipeline */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Job Pipeline</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/jobs')}>View All Jobs</Button>
          </div>
          <JobPipeline />
        </section>
      </div>

      <AddCandidateDialog open={addCandidateOpen} onOpenChange={setAddCandidateOpen} />
      <AddJobDialog open={addJobOpen} onOpenChange={setAddJobOpen} />
      <AddContactDialog open={addContactOpen} onOpenChange={setAddContactOpen} />
    </MainLayout>
  );
};

export default Dashboard;
