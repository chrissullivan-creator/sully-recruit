import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { mockJobs } from '@/data/mockData';
import { Plus, LayoutGrid, List, Search } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { JobCard } from '@/components/pipeline/JobCard';
import type { JobStage } from '@/types';

const stageLabels: Record<JobStage, string> = {
  warm: 'Warm',
  hot: 'Hot',
  interviewing: 'Interviewing',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined',
  lost: 'Lost',
  on_hold: 'On Hold',
};

const Jobs = () => {
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredJobs = mockJobs.filter((job) =>
    job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    job.company.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <MainLayout>
      <PageHeader 
        title="Jobs" 
        description="Track your active job requisitions through the pipeline."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setView('pipeline')}
                className={cn(
                  'p-2 transition-colors',
                  view === 'pipeline' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView('list')}
                className={cn(
                  'p-2 transition-colors',
                  view === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <Button variant="gold">
              <Plus className="h-4 w-4" />
              Add Job
            </Button>
          </div>
        }
      />
      
      <div className="p-8">
        {/* Search */}
        <div className="relative max-w-md mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search jobs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {view === 'pipeline' ? (
          <JobPipeline />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Stage</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Salary</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Candidates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.title}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.company}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.location}</td>
                    <td className="px-4 py-3">
                      <span className="stage-badge stage-warm">{stageLabels[job.stage]}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-accent font-medium">{job.salary || '-'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.candidateCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
};

export default Jobs;
