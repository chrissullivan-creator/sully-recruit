import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { AddJobDialog } from '@/components/jobs/AddJobDialog';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { useJobs } from '@/hooks/useSupabaseData';
import { Plus, LayoutGrid, List, Search, Upload, ListTodo } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

const Jobs = () => {
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const { data: jobs = [], isLoading } = useJobs();

  const filteredJobs = jobs.filter((job) =>
    job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (job.company_name ?? '').toLowerCase().includes(searchQuery.toLowerCase())
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
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1" />
              Import CSV
            </Button>
            <Button variant="gold" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Job
            </Button>
          </div>
        }
      />
      
      <div className="p-8">
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

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading jobs...</p>
        ) : view === 'pipeline' ? (
          <JobPipeline />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                 {filteredJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.title}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {job.company_name ?? (job.companies as any)?.name ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.location ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className="stage-badge stage-warm">{job.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setTaskPanel({ id: job.id, name: job.title })}>
                        <ListTodo className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AddJobDialog open={addOpen} onOpenChange={setAddOpen} />
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} entityType="jobs" />
    </MainLayout>
  );
};

export default Jobs;
