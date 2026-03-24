import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
// CandidatePipeline removed from dashboard per user request
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { DashboardTasks } from '@/components/tasks/DashboardTasks';
import { Button } from '@/components/ui/button';
import { useDashboardMetrics } from '@/hooks/useData';
import { useAuth } from '@/contexts/AuthContext';
import {
  Briefcase,
  Users,
  Calendar,
  FileText,
  Target,
  Phone,
  Mail,
  TrendingUp,
  Plus,
  Sparkles,
  User,
} from 'lucide-react';

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const Dashboard = () => {
  const { data: metrics, isLoading } = useDashboardMetrics();
  const { user } = useAuth();

  const displayName = user?.user_metadata?.display_name?.split(' ')[0] || 'there';

  return (
    <MainLayout>
      <PageHeader 
        title="Dashboard" 
        description="Welcome back. Here's what's happening today."
        actions={
          <Button variant="gold">
            <Plus className="h-4 w-4" />
            Quick Add
          </Button>
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
                {getGreeting()}, {displayName} 👋
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isLoading ? 'Loading your stats...' : (
                  <>
                    You have <span className="font-semibold text-foreground">{metrics?.activeJobs ?? 0} active jobs</span> and{' '}
                    <span className="font-semibold text-foreground">{metrics?.totalCandidates ?? 0} candidates</span> in pipeline.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-gold/5 blur-2xl" />
          <div className="absolute -right-2 -bottom-8 h-24 w-24 rounded-full bg-accent/5 blur-xl" />
        </div>

        {/* Primary Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <MetricCard label="Active Jobs" value={isLoading ? '...' : (metrics?.activeJobs ?? 0)} icon={<Briefcase className="h-5 w-5" />} />
          <MetricCard label="My Candidates" value={isLoading ? '...' : (metrics?.myCandidates ?? 0)} icon={<User className="h-5 w-5" />} />
          <MetricCard label="New" value={isLoading ? '...' : (metrics?.newCandidates ?? 0)} icon={<Users className="h-5 w-5" />} />
          <MetricCard label="Contacted" value={isLoading ? '...' : (metrics?.contactedCandidates ?? 0)} icon={<Mail className="h-5 w-5" />} />
          <MetricCard label="Pitched" value={isLoading ? '...' : (metrics?.pitchedCandidates ?? 0)} icon={<Target className="h-5 w-5" />} />
        </div>

        {/* Pipeline Stage Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Send Out" value={isLoading ? '...' : (metrics?.sendOutCandidates ?? 0)} icon={<FileText className="h-5 w-5" />} />
          <MetricCard label="Submitted" value={isLoading ? '...' : (metrics?.submittedCandidates ?? 0)} icon={<TrendingUp className="h-5 w-5" />} />
          <MetricCard label="Interviewing" value={isLoading ? '...' : (metrics?.interviewingCandidates ?? 0)} icon={<Calendar className="h-5 w-5" />} />
          <MetricCard label="Offers Out" value={isLoading ? '...' : (metrics?.offerCandidates ?? 0)} icon={<Phone className="h-5 w-5" />} />
        </div>

        {/* Tasks + Activity Feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <DashboardTasks />
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Recent Activity</h2>
              <ActivityFeed />
            </div>
          </div>
          <div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Quick Actions</h2>
              <div className="space-y-2">
                <Button variant="outline" className="w-full justify-start"><Plus className="h-4 w-4 mr-2" />Add New Lead</Button>
                <Button variant="outline" className="w-full justify-start"><Users className="h-4 w-4 mr-2" />Add Candidate</Button>
                <Button variant="outline" className="w-full justify-start"><Briefcase className="h-4 w-4 mr-2" />Create Job</Button>
                <Button variant="outline" className="w-full justify-start"><Mail className="h-4 w-4 mr-2" />New Sequence</Button>
              </div>
            </div>
          </div>
        </div>

        {/* Job Pipeline */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Job Pipeline</h2>
            <Button variant="ghost" size="sm">View All Jobs</Button>
          </div>
          <JobPipeline />
        </section>
      </div>
    </MainLayout>
  );
};

export default Dashboard;
