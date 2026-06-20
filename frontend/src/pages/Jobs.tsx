import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { JobPipeline } from '@/components/pipeline/JobPipeline';
import { AddJobDialog } from '@/components/jobs/AddJobDialog';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { useJobs } from '@/hooks/useData';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { Plus, LayoutGrid, List, Search, Upload, ListTodo, MoreHorizontal, Briefcase, RefreshCw, Trash2, Sparkles, Eye } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { JOB_STATUSES, jobStatusMeta, jobStatusLabel } from '@/lib/jobStatus';
import { invalidateJobScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';
import { TableSkeleton, EmptyState } from '@/components/shared/EmptyState';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const Jobs = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  // List view: optionally include closed (filled / closed_lost) jobs so they
  // can be reviewed and bulk-reactivated; the board always shows closed columns.
  const [showClosed, setShowClosed] = useState(false);
  // Bulk-selection state (list view).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const queryClient = useQueryClient();
  const { data: jobs = [], isLoading } = useJobs(showClosed);

  const JOB_STATUS_OPTIONS = JOB_STATUSES.map((s) => ({ value: s.value, label: s.label }));

  const handleQuickStatusChange = async (jobId: string, newStatus: string) => {
    try {
      const { error } = await supabase.from('jobs').update({ status: newStatus }).eq('id', jobId);
      if (error) throw new Error(error.message);
      toast.success(`Job status updated to ${JOB_STATUS_OPTIONS.find(o => o.value === newStatus)?.label ?? newStatus}`);
      invalidateJobScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    }
  };

  const handleQuickDelete = async (jobId: string) => {
    try {
      const { error } = await softDelete('jobs', jobId).then(({ error }) => ({ error: error ? new Error(error.message) : null }));
      if (error) throw new Error(error.message);
      toast.success('Job deleted');
      invalidateJobScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete job');
    }
  };

  const filteredJobs = jobs.filter((job) =>
    job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (job.company_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    ((job as any).job_code ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Bulk selection (list view) ────────────────────────────────────────────
  const toggleSelect = (jobId: string) =>
    setSelectedIds((prev) => prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId]);

  const allOnPageSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.includes(j.id));
  const toggleSelectAll = () => {
    const pageIds = filteredJobs.map((j) => j.id);
    setSelectedIds((prev) => allOnPageSelected ? prev.filter((id) => !pageIds.includes(id)) : [...new Set([...prev, ...pageIds])]);
  };
  const clearSelection = () => setSelectedIds([]);

  const handleBulkStatusChange = async (newStatus: string) => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { error } = await supabase.from('jobs').update({ status: newStatus }).in('id', selectedIds);
      if (error) throw new Error(error.message);
      toast.success(`${selectedIds.length} job${selectedIds.length === 1 ? '' : 's'} moved to ${JOB_STATUS_OPTIONS.find(o => o.value === newStatus)?.label ?? newStatus}`);
      clearSelection();
      invalidateJobScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { error } = await softDelete('jobs', selectedIds);
      if (error) throw new Error(error.message);
      toast.success(`${selectedIds.length} job${selectedIds.length === 1 ? '' : 's'} deleted`);
      clearSelection();
      invalidateJobScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete jobs');
    } finally {
      setBulkBusy(false);
    }
  };

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
      
      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="relative max-w-md flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search jobs…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {view === 'list' && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <Checkbox checked={showClosed} onCheckedChange={(v) => setShowClosed(!!v)} />
              Show closed (Filled / Closed Lost)
            </label>
          )}
        </div>

        {/* Bulk action bar — list view, when rows are selected. */}
        {view === 'list' && selectedIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5">
            <span className="text-sm font-medium text-foreground">{selectedIds.length} selected</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={bulkBusy}>
                  <RefreshCw className="h-3.5 w-3.5" /> Change Status
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {JOB_STATUS_OPTIONS.map((o) => (
                  <DropdownMenuItem key={o.value} onClick={() => handleBulkStatusChange(o.value)}>
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive" disabled={bulkBusy}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {selectedIds.length} job{selectedIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    They'll be moved to trash and can be restored from /audit/trash within 30 days.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleBulkDelete}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button variant="ghost" size="sm" className="h-8 ml-auto" onClick={clearSelection}>Clear</Button>
          </div>
        )}

        {isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : filteredJobs.length === 0 && !searchQuery ? (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Track open roles, send candidates out, and manage the pipeline. Create your first job to get started."
            action={{ label: 'Add Job', icon: Plus, onClick: () => setAddOpen(true) }}
          />
        ) : view === 'pipeline' ? (
          <JobPipeline />
        ) : (
          <HorizontalTableScroll className="rounded-lg border border-border overflow-hidden" minWidth={1200}>
            <table className="w-full">
              <thead className="table-header-green">
                <tr>
                  <th className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={allOnPageSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Code</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Openings</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                 {filteredJobs.map((job) => (
                  <tr key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className={cn('group hover:bg-muted/50 transition-colors cursor-pointer', selectedIds.includes(job.id) && 'bg-accent/5')}>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.includes(job.id)} onCheckedChange={() => toggleSelect(job.id)} aria-label={`Select ${job.title}`} />
                    </td>
                    <td className="px-4 py-3">
                      {(job as any).job_code ? (
                        <span className="font-mono text-xs font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded">{(job as any).job_code}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.title}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {(() => {
                        const companyName = job.company_name ?? (job.companies as any)?.name ?? '-';
                        const companyDomain = (job.companies as any)?.domain ?? null;
                        const companyLogoUrl = (job.companies as any)?.logo_url ?? null;
                        return (
                          <span className="flex items-center gap-2">
                            <CompanyLogo name={companyName} domain={companyDomain} logoUrl={companyLogoUrl} size="xs" />
                            {companyName}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{job.location ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{(job as any).num_openings ?? 1}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        jobStatusMeta(job.status)?.pillClass ?? 'bg-gray-100 text-gray-600',
                      )}>
                        {jobStatusLabel(job.status)}
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
          </HorizontalTableScroll>
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
