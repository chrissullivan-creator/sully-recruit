import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { CandidatePipeline } from '@/components/pipeline/CandidatePipeline';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { Button } from '@/components/ui/button';
import { mockDashboardMetrics } from '@/data/mockData';
import { 
  Briefcase, 
  Users, 
  Calendar, 
  FileText, 
  Target,
  Phone,
  Mail,
  TrendingUp,
  Plus
} from 'lucide-react';

const Dashboard = () => {
  const metrics = mockDashboardMetrics;

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
        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Active Jobs"
            value={metrics.activeJobs}
            change={{ value: 12, isPositive: true }}
            icon={<Briefcase className="h-5 w-5" />}
          />
          <MetricCard
            label="Active Candidates"
            value={metrics.activeCandidates}
            change={{ value: 8, isPositive: true }}
            icon={<Users className="h-5 w-5" />}
          />
          <MetricCard
            label="Interviews This Week"
            value={metrics.interviewsThisWeek}
            change={{ value: 25, isPositive: true }}
            icon={<Calendar className="h-5 w-5" />}
          />
          <MetricCard
            label="Offers Out"
            value={metrics.offersOut}
            icon={<FileText className="h-5 w-5" />}
          />
        </div>

        {/* Secondary Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Leads to Follow"
            value={metrics.leadsToFollow}
            icon={<Target className="h-5 w-5" />}
          />
          <MetricCard
            label="Calls Today"
            value={metrics.callsToday}
            icon={<Phone className="h-5 w-5" />}
          />
          <MetricCard
            label="Emails Sent"
            value={metrics.emailsSent}
            icon={<Mail className="h-5 w-5" />}
          />
          <MetricCard
            label="Response Rate"
            value={`${(metrics.responseRate * 100).toFixed(0)}%`}
            change={{ value: 5, isPositive: true }}
            icon={<TrendingUp className="h-5 w-5" />}
          />
        </div>

        {/* Job Pipeline */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Job Pipeline</h2>
            <Button variant="ghost" size="sm">View All Jobs</Button>
          </div>
          <JobPipeline />
        </section>

        {/* Candidate Pipeline */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Candidate Pipeline</h2>
            <Button variant="ghost" size="sm">View All Candidates</Button>
          </div>
          <CandidatePipeline />
        </section>

        {/* Activity Feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Recent Activity</h2>
              <ActivityFeed />
            </div>
          </div>
          <div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Quick Actions</h2>
              <div className="space-y-2">
                <Button variant="outline" className="w-full justify-start">
                  <Plus className="h-4 w-4 mr-2" />
                  Add New Lead
                </Button>
                <Button variant="outline" className="w-full justify-start">
                  <Users className="h-4 w-4 mr-2" />
                  Add Candidate
                </Button>
                <Button variant="outline" className="w-full justify-start">
                  <Briefcase className="h-4 w-4 mr-2" />
                  Create Job
                </Button>
                <Button variant="outline" className="w-full justify-start">
                  <Mail className="h-4 w-4 mr-2" />
                  Send Campaign
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
};

export default Dashboard;
