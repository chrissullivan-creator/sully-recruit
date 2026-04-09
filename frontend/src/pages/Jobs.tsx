import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { AddJobDialog } from '@/components/jobs/AddJobDialog';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { useJobs } from '@/hooks/useData';
import { Plus, LayoutGrid, List, Search, Upload, ListTodo, MoreHorizontal, Briefcase, RefreshCw, Trash2, Sparkles, Eye } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const Jobs = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const queryClient = useQueryClient();
  const { data: jobs = [], isLoading } = useJobs();

  const JOB_STATUS_OPTIONS = [
    { value: 'lead', label: 'Lead' },
    { value: 'hot', label: 'Hot' },
    { value: 'offer_made', label: 'Offer Made' },
    { value: 'closed_won', label: 'Closed Won' },
    { value: 'closed_lost', label: 'Closed Lost' },
  ];

  const handleQuickStatusChange = async (jobId: string, newStatus: string) => {
    try {
      const { error } = await supabase.from('jobs').update({ status: newStatus }).eq('id', jobId);
      if (error) throw new Error(error.message);
      toast.success(`Job status updated to ${JOB_STATUS_OPTIONS.find(o => o.value === newStatus)?.label ?? newStatus}`);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    }
  };

  const handleQuickDelete = async (jobId: string) => {
    try {
      const { error } = await supabase.from('jobs').delete().eq('id', jobId);
      if (error) throw new Error(error.message);
      toast.success('Job deleted');
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete job');
    }
  };

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
              <thead className="table-header-green">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                 {filteredJobs.map((job) => (
                  <tr key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className="group hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.title}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {job.company_name ?? (job.companies as any)?.name ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.location ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        job.status === 'lead' && 'bg-gray-100 text-gray-600',
                        job.status === 'hot' && 'bg-[#C9A84C]/10 text-[#C9A84C]',
                        job.status === 'offer_made' && 'bg-[#2A5C42]/10 text-[#2A5C42]',
                        job.status === 'closed_won' && 'bg-[#1C3D2E] text-white',
                        job.status === 'closed_lost' && 'bg-[#FEF2F2] text-[#DC2626]',
                      )}>
                        {job.status === 'lead' ? 'Lead' : job.status === 'hot' ? 'Hot' : job.status === 'offer_made' ? 'Offer Made' : job.status === 'closed_won' ? 'Closed Won' : job.status === 'closed_lost' ? 'Closed Lost' : job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => navigate(`/jobs/${job.id}`)}>
                            <Eye className="h-3.5 w-3.5 mr-2" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTaskPanel({ id: job.id, name: job.title })}>
                            <ListTodo className="h-3.5 w-3.5 mr-2" /> Tasks
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <RefreshCw className="h-3.5 w-3.5 mr-2" /> Change Status
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {JOB_STATUS_OPTIONS.filter(o => o.value !== job.status).map(o => (
                                <DropdownMenuItem key={o.value} onClick={() => handleQuickStatusChange(job.id, o.value)}>
                                  {o.label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => handleQuickDelete(job.id)}>
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
      {taskPanel && (
        <TaskSlidePanel
          open={!!taskPanel}
          onOpenChange={(open) => !open && setTaskPanel(null)}
          entityType="job"
          entityId={taskPanel.id}
          entityName={taskPanel.name}
        />
      )}
    </MainLayout>
  );
};

export default Jobs;
