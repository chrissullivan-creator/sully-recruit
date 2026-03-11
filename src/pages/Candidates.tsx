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
import { Plus, LayoutGrid, List, Search, Building, Play, ArrowUpDown, ArrowUp, ArrowDown, Upload, FileSearch, FileUp, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ResumeDropZone } from '@/components/shared/ResumeDropZone';

type SortField = 'name' | 'title' | 'company' | 'status' | 'created';
type SortDir = 'asc' | 'desc';

const statusFilters = ['all', 'new', 'reached_out', 'back_of_resume', 'placed'] as const;
const statusColors: Record<string, string> = {
  new:            'bg-blue-500/10 text-blue-400 border-blue-500/20',
  reached_out:    'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  back_of_resume: 'bg-muted text-muted-foreground border-border',
  placed:         'bg-success/10 text-success border-success/20',
};

const Candidates = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<'pipeline' | 'list'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [jobTagFilter, setJobTagFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { data: candidates = [], isLoading } = useCandidates();
  const { data: jobs = [] } = useJobs();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [resumeSearchOpen, setResumeSearchOpen] = useState(false);
  const [resumeDropOpen, setResumeDropOpen] = useState(false);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [askJoeSearchOpen, setAskJoeSearchOpen] = useState(false);

  const filteredCandidates = useMemo(() => {
    let list = candidates.filter((c) => {
      const matchesSearch =
        (c.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.current_company ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.current_title ?? '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
      const matchesJobTag = jobTagFilter === 'all' || c.tagged_job_id === jobTagFilter;
      return matchesSearch && matchesStatus && matchesJobTag;
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
  }, [candidates, searchQuery, statusFilter, jobTagFilter, sortField, sortDir]);

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
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Status:</span>
            {statusFilters.map((s) => (
              <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(s)} className="capitalize text-xs">
                {s === 'all' ? 'All' : s.replace('_', ' ')}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Jobs:</span>
            <Button variant={jobTagFilter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setJobTagFilter('all')} className="text-xs">
              All Candidates
            </Button>
            {jobs.filter(j => j.status !== 'closed').map((job) => (
              <Button key={job.id} variant={jobTagFilter === job.id ? 'secondary' : 'ghost'} size="sm" onClick={() => setJobTagFilter(job.id)} className="text-xs max-w-[150px] truncate">
                {job.title}
              </Button>
            ))}
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
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
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
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCandidates.map((candidate) => (
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
                          {candidate.status.replace(/_/g, ' ')}
                        </span>
                        {candidate.no_answer && (
                          <span className="stage-badge bg-orange-500/10 text-orange-400 border border-orange-500/20">
                            no answer
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground" onClick={() => navigate(`/candidates/${candidate.id}`)}>{candidate.email ?? '-'}</td>
                  </tr>
                ))}
                {filteredCandidates.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No candidates match your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
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
    </MainLayout>
  );
};

export default Candidates;
