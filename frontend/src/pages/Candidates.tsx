import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CandidatePipeline } from '@/components/pipeline/CandidatePipeline';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { BulkCandidateActionsDialog } from '@/components/candidates/BulkCandidateActionsDialog';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { AddCandidateDialog } from '@/components/candidates/AddCandidateDialog';
import { ResumeSearchDialog } from '@/components/candidates/ResumeSearchDialog';
import { AskJoeAdvancedSearch } from '@/components/candidates/AskJoeAdvancedSearch';
import { AskJoeSearch } from '@/components/candidates/AskJoeSearch';
import { useCandidates, useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Plus, LayoutGrid, List, Search, Building, Play, ArrowUpDown, ArrowUp, ArrowDown, Upload, FileSearch, FileUp, Sparkles, X, Target, User, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ResumeDropZone } from '@/components/shared/ResumeDropZone';
import { format } from 'date-fns';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const JOB_STATUS_COLORS: Record<string, string> = {
  pitched:      'bg-blue-500/10 text-blue-400',
  send_out:     'bg-yellow-500/10 text-yellow-400',
  submitted:    'bg-purple-500/10 text-purple-400',
  interviewing: 'bg-orange-500/10 text-orange-400',
  offer:        'bg-emerald-500/10 text-emerald-400',
  placed:       'bg-green-500/10 text-green-400',
  rejected:     'bg-red-500/10 text-red-400',
  withdrew:     'bg-muted text-muted-foreground',
};

type SortField = 'name' | 'title' | 'company' | 'status' | 'created';
type SortDir = 'asc' | 'desc';

const statusFilters = ['all', 'new', 'reached_out', 'back_of_resume', 'placed'] as const;
const STATUS_LABELS: Record<string, string> = {
  all: 'All',
  new: 'New',
  reached_out: 'Reached Out',
  back_of_resume: 'Back of Resume',
  placed: 'Placed',
};
const statusColors: Record<string, string> = {
  new:            'bg-blue-500/10 text-blue-400 border-blue-500/20',
  reached_out:    'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  back_of_resume: 'bg-muted text-muted-foreground border-border',
  placed:         'bg-success/10 text-success border-success/20',
};

const Candidates = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [view, setView] = useState<'pipeline' | 'list'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [jobTagFilter, setJobTagFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { data: candidates = [], isLoading } = useCandidates();
  const { data: jobs = [] } = useJobs();
  const { data: profiles = [] } = useProfiles();
  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [resumeSearchOpen, setResumeSearchOpen] = useState(false);
  const [resumeDropOpen, setResumeDropOpen] = useState(false);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [askJoeSearchOpen, setAskJoeSearchOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();
  const PAGE_SIZE = 100;

  const filteredCandidates = useMemo(() => {
    let list = candidates.filter((c) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q ||
        (c.full_name ?? '').toLowerCase().includes(q) ||
        (c.first_name ?? '').toLowerCase().includes(q) ||
        (c.last_name ?? '').toLowerCase().includes(q) ||
        (c.current_company ?? '').toLowerCase().includes(q) ||
        (c.current_title ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        (`${c.first_name ?? ''} ${c.last_name ?? ''}`).toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
      const matchesJobTag = jobTagFilter === 'all' || (c as any).job_id === jobTagFilter;
      const matchesOwner = ownerFilter === 'all' ? true : ownerFilter === 'mine' ? c.owner_id === user?.id : c.owner_id === ownerFilter;
      return matchesSearch && matchesStatus && matchesJobTag && matchesOwner;
    });

    list.sort((a, b) => {
      let aVal = '', bVal = '';
      switch (sortField) {
        case 'name': aVal = a.full_name ?? ''; bVal = b.full_name ?? ''; break;
        case 'title': aVal = a.current_title ?? ''; bVal = b.current_title ?? ''; break;
        case 'company': aVal = a.current_company ?? ''; bVal = b.current_company ?? ''; break;
        case 'status': aVal = a.status; bVal = b.status; break;
        case 'created': aVal = a.created_at; bVal = b.created_at; break;
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [candidates, searchQuery, statusFilter, jobTagFilter, ownerFilter, sortField, sortDir, user?.id]);

  // Reset page when filters change
  const totalPages = Math.ceil(filteredCandidates.length / PAGE_SIZE);
  const paginatedCandidates = filteredCandidates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === filteredCandidates.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredCandidates.map((c) => c.id));
    }
  };

  const selectedNames = candidates
    .filter((c) => selectedIds.includes(c.id))
    .map((c) => c.full_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`);

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from('candidates')
        .delete()
        .in('id', selectedIds);

      if (error) throw new Error(error.message);

      toast.success(`Deleted ${selectedIds.length} candidate${selectedIds.length !== 1 ? 's' : ''}`);
      setSelectedIds([]);
      setDeleteConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete candidates');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader 
        title="Candidates" 
        description="Track candidates through interview stages across all jobs."
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
            <Button variant="ghost" size="sm" onClick={() => setAskJoeSearchOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1" />
              Ask Joe — Search
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/resume-search')}>
              <FileSearch className="h-4 w-4 mr-1" />
              Resume Search
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setResumeDropOpen(true)}>
              <FileUp className="h-4 w-4 mr-1" />
              Resume Drop
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1" />
              Import CSV
            </Button>
            <Button variant="gold" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Candidate
            </Button>
          </div>
        }
      />
      
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search candidates..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {statusFilters.filter(s => s !== 'all').map(s => (
                  <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={jobTagFilter} onValueChange={(v) => { setJobTagFilter(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-52 text-xs">
                <SelectValue placeholder="All Jobs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Jobs</SelectItem>
                {(jobs as any[])
                  .filter(j => j.status !== 'lost' && j.status !== 'on_hold')
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map(job => (
                    <SelectItem key={job.id} value={job.id}>
                      {job.title}{job.company_name ? ` — ${job.company_name}` : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            <Select value={ownerFilter} onValueChange={(v) => { setOwnerFilter(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="All Owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Owners</SelectItem>
                <SelectItem value="mine">My Candidates</SelectItem>
                {profiles.filter(p => p.full_name).map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedIds.length > 0 && (
            <>
              <Button variant="gold" size="sm" onClick={() => setBulkActionsOpen(true)}>
                <Play className="h-3.5 w-3.5" />
                Bulk Actions ({selectedIds.length})
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
                <Play className="h-3.5 w-3.5" />
                Enroll in Sequence ({selectedIds.length})
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(true)} className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30">
                <Trash2 className="h-3.5 w-3.5" />
                Delete ({selectedIds.length})
              </Button>
            </>
          )}

          {filteredCandidates.length > 0 && selectedIds.length !== filteredCandidates.length && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Add All ({filteredCandidates.length})
            </Button>
          )}

          {selectedIds.length === filteredCandidates.length && filteredCandidates.length > 0 && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Deselect All
            </Button>
          )}
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading candidates...</p>
        ) : view === 'pipeline' ? (
          <CandidatePipeline />
        ) : (
          <>
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-secondary">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={selectedIds.length === filteredCandidates.length && filteredCandidates.length > 0}
                      onCheckedChange={toggleAll}
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('name')}>
                    <span className="flex items-center gap-1">Name <SortIcon field="name" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('title')}>
                    <span className="flex items-center gap-1">Title <SortIcon field="title" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('company')}>
                    <span className="flex items-center gap-1">Company <SortIcon field="company" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('status')}>
                    <span className="flex items-center gap-1">Status <SortIcon field="status" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Job</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('created')}>
                    <span className="flex items-center gap-1">Added <SortIcon field="created" /></span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paginatedCandidates.map((candidate) => (
                  <tr key={candidate.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.includes(candidate.id)}
                        onCheckedChange={() => toggleSelect(candidate.id)}
                      />
                    </td>
                    <td className="px-4 py-3" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                          {(candidate.first_name?.[0] ?? '')}{(candidate.last_name?.[0] ?? '')}
                        </div>
                        <span className="text-sm font-medium text-foreground">
                          {candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground" onClick={() => navigate(`/candidates/${candidate.id}`)}>{candidate.current_title ?? '-'}</td>
                    <td className="px-4 py-3" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Building className="h-3 w-3" />
                        {candidate.current_company ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      <div className="flex items-center gap-1.5">
                        <span className={cn('stage-badge border', statusColors[candidate.status] ?? 'bg-muted text-muted-foreground border-border')}>
                          {STATUS_LABELS[candidate.status] ?? candidate.status.replace(/_/g, ' ')}
                        </span>
                        {(candidate as any).no_answer && (
                          <span className="stage-badge bg-orange-500/10 text-orange-400 border border-orange-500/20">
                            no answer
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      {(() => {
                        const ownerProfile = candidate.owner_id ? profileMap[candidate.owner_id] : null;
                        const ownerName = ownerProfile?.full_name;
                        const ownerInitials = ownerName ? ownerName.split(' ').map((n: string) => n[0]).join('').slice(0, 2) : '';
                        return ownerName ? (
                          <div className="flex items-center gap-1.5">
                            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[9px] font-medium text-accent">{ownerInitials}</div>
                            <span className="text-xs text-muted-foreground truncate max-w-[80px]">{ownerName.split(' ')[0]}</span>
                          </div>
                        ) : <span className="text-xs text-muted-foreground">—</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      {(candidate as any).job_id ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs text-foreground truncate max-w-[140px]">
                            {jobs.find((j: any) => j.id === (candidate as any).job_id)?.title ?? '—'}
                          </span>
                          {(candidate as any).job_status && (
                            <span className={cn('text-xs px-1.5 py-0.5 rounded w-fit font-medium', JOB_STATUS_COLORS[(candidate as any).job_status] ?? 'bg-muted text-muted-foreground')}>
                              {(candidate as any).job_status.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      {format(new Date(candidate.created_at), 'MMM d, yyyy')}
                    </td>
                  </tr>
                ))}
                {paginatedCandidates.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">No candidates match your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredCandidates.length)} of {filteredCandidates.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(1)}>First</Button>
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <span className="text-xs text-muted-foreground px-2">Page {page} of {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(totalPages)}>Last</Button>
              </div>
            </div>
          )}
          </>
        )}
      </div>

      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        candidateIds={selectedIds}
        candidateNames={selectedNames}
      />
      <BulkCandidateActionsDialog
        open={bulkActionsOpen}
        onOpenChange={setBulkActionsOpen}
        candidateIds={selectedIds}
        candidateNames={selectedNames}
      />
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} entityType="candidates" />
      <AddCandidateDialog open={addOpen} onOpenChange={setAddOpen} />
      <AskJoeAdvancedSearch open={advancedSearchOpen} onOpenChange={setAdvancedSearchOpen} mode="candidate_search" />
      <AskJoeSearch open={askJoeSearchOpen} onOpenChange={setAskJoeSearchOpen} />
      <ResumeSearchDialog open={resumeSearchOpen} onOpenChange={setResumeSearchOpen} />
      <ResumeDropZone entityType="candidate" open={resumeDropOpen} onOpenChange={setResumeDropOpen} />

      {/* Bulk Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Candidates
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete {selectedIds.length} candidate{selectedIds.length > 1 ? 's' : ''}? This will also remove their sequence enrollments and notes. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {selectedNames.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 max-h-32 overflow-y-auto">
              <p className="text-xs text-muted-foreground mb-1 font-medium">Selected:</p>
              {selectedNames.slice(0, 10).map((name, i) => (
                <p key={i} className="text-xs text-foreground">{name}</p>
              ))}
              {selectedNames.length > 10 && (
                <p className="text-xs text-muted-foreground mt-1">...and {selectedNames.length - 10} more</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Delete {selectedIds.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default Candidates;
