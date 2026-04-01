import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { CandidatePipeline } from '@/components/pipeline/CandidatePipeline';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { BulkCandidateActionsDialog } from '@/components/candidates/BulkCandidateActionsDialog';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { AddCandidateDialog } from '@/components/candidates/AddCandidateDialog';
import { ResumeSearchDialog } from '@/components/candidates/ResumeSearchDialog';
import { AskJoeAdvancedSearch } from '@/components/candidates/AskJoeAdvancedSearch';
import { AskJoeSearch } from '@/components/candidates/AskJoeSearch';
import { UnifiedSearchDialog } from '@/components/candidates/UnifiedSearchDialog';
import {
  CandidateFilterSidebar,
  DEFAULT_FILTERS,
  getActiveFilterCount,
  getActiveFilterChips,
  clearFilterByKey,
  type CandidateFilters,
  type SavedSearch,
} from '@/components/candidates/CandidateFilterSidebar';
import { booleanMatch, hasBooleanOperators } from '@/lib/booleanSearch';
import { haversineDistanceMiles } from '@/lib/geocoding';
import { useCandidates, useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { Plus, LayoutGrid, List, Search, Building, Play, ArrowUpDown, ArrowUp, ArrowDown, Upload, FileSearch, FileUp, Sparkles, X, Target, User, Trash2, Loader2, AlertTriangle, SlidersHorizontal, HelpCircle, MoreHorizontal, Mail, RefreshCw, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ResumeDropZone } from '@/components/shared/ResumeDropZone';
import { format } from 'date-fns';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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

type SortField = 'name' | 'title' | 'company' | 'status' | 'created' | 'updated';
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

// Saved searches persisted to localStorage
const SAVED_SEARCHES_KEY = 'sully-recruit-saved-searches';
function loadSavedSearches(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function persistSavedSearches(searches: SavedSearch[]) {
  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches));
}

const Candidates = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [view, setView] = useState<'pipeline' | 'list'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<CandidateFilters>(DEFAULT_FILTERS);
  const [filterSidebarOpen, setFilterSidebarOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>('updated');
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
  const [unifiedSearchOpen, setUnifiedSearchOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(loadSavedSearches);
  const queryClient = useQueryClient();
  const PAGE_SIZE = 100;

  // Derive unique skills and locations from candidate data for filter suggestions
  const availableSkills = useMemo(() => {
    const skills = new Set<string>();
    for (const c of candidates) {
      const s = (c as any).skills;
      if (Array.isArray(s)) s.forEach((sk: string) => skills.add(sk));
      else if (typeof s === 'string' && s) s.split(',').forEach((sk: string) => { const t = sk.trim(); if (t) skills.add(t); });
    }
    return Array.from(skills).sort();
  }, [candidates]);

  const availableLocations = useMemo(() => {
    const locs = new Set<string>();
    for (const c of candidates) {
      const loc = (c as any).location_text || (c as any).location;
      if (loc && typeof loc === 'string') locs.add(loc);
    }
    return Array.from(locs).sort();
  }, [candidates]);

  // Saved search handlers
  const handleSaveSearch = useCallback((name: string) => {
    const newSearch: SavedSearch = {
      id: `ss-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      filters: { ...filters },
      searchQuery,
      created_at: new Date().toISOString(),
    };
    const updated = [newSearch, ...savedSearches];
    setSavedSearches(updated);
    persistSavedSearches(updated);
    toast.success(`Saved search "${name}"`);
  }, [filters, searchQuery, savedSearches]);

  const handleLoadSearch = useCallback((search: SavedSearch) => {
    setFilters(search.filters);
    setSearchQuery(search.searchQuery);
    setPage(1);
    toast.success(`Loaded "${search.name}"`);
  }, []);

  const handleDeleteSearch = useCallback((id: string) => {
    const updated = savedSearches.filter((s) => s.id !== id);
    setSavedSearches(updated);
    persistSavedSearches(updated);
  }, [savedSearches]);

  const filteredCandidates = useMemo(() => {
    let list = candidates.filter((c) => {
      // Boolean search across key fields
      const searchFields = [
        c.full_name ?? '',
        c.first_name ?? '',
        c.last_name ?? '',
        c.current_company ?? '',
        c.current_title ?? '',
        c.email ?? '',
        `${c.first_name ?? ''} ${c.last_name ?? ''}`,
      ];
      const matchesSearch = booleanMatch(searchQuery, searchFields);

      // Status filter
      const matchesStatus = filters.status === 'all' || c.status === filters.status;

      // Job tag filter
      const matchesJobTag = filters.jobTag === 'all' || (c as any).job_id === filters.jobTag;

      // Owner filter
      const matchesOwner = filters.owner === 'all' ? true : filters.owner === 'mine' ? c.owner_id === user?.id : c.owner_id === filters.owner;

      // Location filter (text match or radius)
      const candLocation = ((c as any).location_text || (c as any).location || '').toLowerCase();
      let matchesLocation = true;
      if (filters.location) {
        const radius = filters.locationRadius ?? 0;
        const fLat = filters.locationLat ?? null;
        const fLng = filters.locationLng ?? null;
        if (radius > 0 && fLat !== null && fLng !== null) {
          // Radius search: check if candidate has coordinates, else fall back to text match
          const candLat = (c as any).latitude ?? (c as any).lat;
          const candLng = (c as any).longitude ?? (c as any).lng ?? (c as any).lon;
          if (candLat != null && candLng != null) {
            const dist = haversineDistanceMiles(fLat, fLng, candLat, candLng);
            matchesLocation = dist <= radius;
          } else {
            matchesLocation = candLocation.includes(filters.location.toLowerCase());
          }
        } else {
          matchesLocation = candLocation.includes(filters.location.toLowerCase());
        }
      }

      // Title filter (partial match)
      const matchesTitle = !filters.title || (c.current_title ?? '').toLowerCase().includes(filters.title.toLowerCase());

      // Company filter (partial match)
      const matchesCompany = !filters.company || (c.current_company ?? '').toLowerCase().includes(filters.company.toLowerCase());

      // Skills filter
      const matchesSkills = filters.skills.length === 0 || (() => {
        const candidateSkills = (() => {
          const s = (c as any).skills;
          if (Array.isArray(s)) return s.map((sk: string) => sk.toLowerCase());
          if (typeof s === 'string' && s) return s.split(',').map((sk: string) => sk.trim().toLowerCase());
          return [];
        })();
        // Also search in title and company for skill keywords
        const allText = [...candidateSkills, (c.current_title ?? '').toLowerCase(), (c.current_company ?? '').toLowerCase()].join(' ');
        return filters.skills.every((skill) => allText.includes(skill));
      })();

      // Work authorization filter
      const matchesWorkAuth = filters.workAuthorization === 'all' ||
        ((c as any).work_authorization ?? '').toLowerCase().includes(filters.workAuthorization.toLowerCase());

      // Date added range
      const createdDate = new Date(c.created_at);
      const matchesDateFrom = !filters.dateAddedFrom || createdDate >= filters.dateAddedFrom;
      const matchesDateTo = !filters.dateAddedTo || createdDate <= filters.dateAddedTo;

      // Last activity
      const updatedDate = (c as any).updated_at ? new Date((c as any).updated_at) : createdDate;
      const matchesLastActivity = !filters.lastActivityFrom || updatedDate >= filters.lastActivityFrom;

      return matchesSearch && matchesStatus && matchesJobTag && matchesOwner &&
        matchesLocation && matchesTitle && matchesCompany && matchesSkills &&
        matchesWorkAuth && matchesDateFrom && matchesDateTo && matchesLastActivity;
    });

    list.sort((a, b) => {
      let aVal = '', bVal = '';
      switch (sortField) {
        case 'name': aVal = a.full_name ?? ''; bVal = b.full_name ?? ''; break;
        case 'title': aVal = a.current_title ?? ''; bVal = b.current_title ?? ''; break;
        case 'company': aVal = a.current_company ?? ''; bVal = b.current_company ?? ''; break;
        case 'status': aVal = a.status; bVal = b.status; break;
        case 'created': aVal = a.created_at; bVal = b.created_at; break;
        case 'updated': aVal = (a as any).updated_at ?? a.created_at; bVal = (b as any).updated_at ?? b.created_at; break;
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [candidates, searchQuery, filters, sortField, sortDir, user?.id]);

  const activeFilterCount = getActiveFilterCount(filters);
  const filterChips = getActiveFilterChips(filters, STATUS_LABELS, jobs, profiles);

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

  // Quick action: change candidate status inline
  const handleQuickStatusChange = async (candidateId: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('candidates')
        .update({ status: newStatus })
        .eq('id', candidateId);
      if (error) throw new Error(error.message);
      toast.success(`Status updated to ${STATUS_LABELS[newStatus] ?? newStatus}`);
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    }
  };

  // Quick action state for single-candidate enroll
  const [quickEnrollId, setQuickEnrollId] = useState<string | null>(null);

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
            <Button variant="ghost" size="sm" onClick={() => setUnifiedSearchOpen(true)}>
              <Globe className="h-4 w-4 mr-1" />
              Search Everything
            </Button>
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
      
      <div className="flex flex-1 overflow-hidden">
        {/* ── Filter Sidebar ─────────────────────────────────────────────── */}
        {filterSidebarOpen && (
          <CandidateFilterSidebar
            filters={filters}
            onFiltersChange={(f) => { setFilters(f); setPage(1); }}
            onClose={() => setFilterSidebarOpen(false)}
            statusOptions={statusFilters.filter(s => s !== 'all').map(s => ({ value: s, label: STATUS_LABELS[s] }))}
            jobs={jobs}
            profiles={profiles}
            availableSkills={availableSkills}
            availableLocations={availableLocations}
            savedSearches={savedSearches}
            onSaveSearch={handleSaveSearch}
            onLoadSearch={handleLoadSearch}
            onDeleteSearch={handleDeleteSearch}
            searchQuery={searchQuery}
          />
        )}

        {/* ── Main content ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-8">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Filter toggle */}
          <Button
            variant={filterSidebarOpen ? 'secondary' : 'outline'}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setFilterSidebarOpen(!filterSidebarOpen)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="ml-0.5 text-[10px] h-5 px-1.5 bg-accent/10 text-accent">
                {activeFilterCount}
              </Badge>
            )}
          </Button>

          {/* Search bar with Boolean support */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search candidates... (supports AND, OR, NOT, &quot;quotes&quot;)"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              className="w-full h-9 pl-10 pr-8 rounded-lg border border-input bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {searchQuery && hasBooleanOperators(searchQuery) && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] text-accent font-medium uppercase tracking-wide">
                Boolean
              </span>
            )}
            {!searchQuery && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    <p className="font-medium mb-1">Boolean Search Syntax</p>
                    <p>React AND TypeScript — both required</p>
                    <p>Python OR Java — either matches</p>
                    <p>NOT junior — exclude term</p>
                    <p>"senior engineer" — exact phrase</p>
                    <p>(React OR Vue) AND NOT intern</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Bulk actions */}
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

        {/* ── Active Filter Chips ──────────────────────────────────────── */}
        {filterChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            {filterChips.map((chip) => (
              <Badge
                key={chip.key}
                variant="secondary"
                className="text-xs gap-1 pr-1 cursor-pointer hover:bg-destructive/10 transition-colors"
                onClick={() => { setFilters(clearFilterByKey(filters, chip.key)); setPage(1); }}
              >
                {chip.label}
                <X className="h-3 w-3" />
              </Badge>
            ))}
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground ml-1 transition-colors"
              onClick={() => { setFilters(DEFAULT_FILTERS); setPage(1); }}
            >
              Clear all
            </button>
          </div>
        )}

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
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('updated')}>
                    <span className="flex items-center gap-1">Updated <SortIcon field="updated" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('created')}>
                    <span className="flex items-center gap-1">Added <SortIcon field="created" /></span>
                  </th>
                  <th className="w-10 px-2 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paginatedCandidates.map((candidate) => (
                  <tr key={candidate.id} className="group hover:bg-muted/50 transition-colors cursor-pointer">
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
                      {(candidate as any).updated_at ? format(new Date((candidate as any).updated_at), 'MMM d, yyyy') : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                      {format(new Date(candidate.created_at), 'MMM d, yyyy')}
                    </td>
                    <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => navigate(`/candidates/${candidate.id}`)}>
                            <User className="h-3.5 w-3.5 mr-2" /> View Profile
                          </DropdownMenuItem>
                          {candidate.email && (
                            <DropdownMenuItem onClick={() => window.open(`mailto:${candidate.email}`)}>
                              <Mail className="h-3.5 w-3.5 mr-2" /> Send Email
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <RefreshCw className="h-3.5 w-3.5 mr-2" /> Change Status
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {statusFilters.filter(s => s !== 'all' && s !== candidate.status).map(s => (
                                <DropdownMenuItem key={s} onClick={() => handleQuickStatusChange(candidate.id, s)}>
                                  {STATUS_LABELS[s]}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuItem onClick={() => { setSelectedIds([candidate.id]); setEnrollOpen(true); }}>
                            <Play className="h-3.5 w-3.5 mr-2" /> Enroll in Sequence
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => { setSelectedIds([candidate.id]); setDeleteConfirmOpen(true); }}>
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
                {paginatedCandidates.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">No candidates match your filters.</td></tr>
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
      <UnifiedSearchDialog open={unifiedSearchOpen} onOpenChange={setUnifiedSearchOpen} />

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
