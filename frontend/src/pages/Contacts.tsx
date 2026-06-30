import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { ActionMenu } from '@/components/shared/ActionMenu';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { EnrichButton } from '@/components/shared/EnrichButton';
import { useContacts, useJobs } from '@/hooks/useData';
import { Plus, Search, Building, Phone, Mail, Linkedin, Upload, ListTodo, Play, Martini, ArrowUpDown, ArrowUp, ArrowDown, MessageCircle, PhoneCall, History, Loader2, MoreHorizontal, User, Users, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { authHeaders } from '@/lib/api-auth';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { CompanyLink } from '@/components/shared/EntityLinks';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import { PersonAvatar } from '@/components/shared/PersonAvatar';
import { Badge } from '@/components/ui/badge';
import {
  ContactFilterSidebar,
  DEFAULT_CONTACT_FILTERS,
  getActiveContactFilterCount,
  getActiveContactFilterChips,
  clearContactFilterByKey,
  type ContactFilters,
  type SavedContactSearch,
} from '@/components/contacts/ContactFilterSidebar';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import { SlidersHorizontal, X } from 'lucide-react';

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  reached_out: 'Reached Out',
  engaged: 'Engaged',
};
const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'reached_out', label: 'Reached Out' },
  { value: 'engaged', label: 'Engaged' },
];

// Saved searches persisted to localStorage (separate key from candidates).
const SAVED_CONTACT_SEARCHES_KEY = 'sully-recruit-saved-contact-searches';
function loadSavedContactSearches(): SavedContactSearch[] {
  try {
    const raw = localStorage.getItem(SAVED_CONTACT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function persistSavedContactSearches(searches: SavedContactSearch[]) {
  localStorage.setItem(SAVED_CONTACT_SEARCHES_KEY, JSON.stringify(searches));
}

// "On or before" date bounds should include the whole selected day.
function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

const SENTIMENT_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  interested:       { label: 'Interested',       bg: 'bg-primary',        text: 'text-white' },
  positive:         { label: 'Positive',         bg: 'bg-success/15',     text: 'text-success' },
  maybe:            { label: 'Maybe',            bg: 'bg-accent/15',      text: 'text-accent' },
  neutral:          { label: 'Neutral',          bg: 'bg-muted',          text: 'text-muted-foreground' },
  negative:         { label: 'Negative',         bg: 'bg-orange-500/10',  text: 'text-orange-600' },
  not_interested:   { label: 'Not Interested',   bg: 'bg-destructive/15', text: 'text-destructive' },
  do_not_contact:   { label: 'Do Not Contact',   bg: 'bg-destructive/25', text: 'text-destructive' },
};

const ChannelBadge = ({ channel }: { channel?: string | null }) => {
  if (!channel) return <span className="text-muted-foreground">—</span>;
  const icon = channel === 'email' ? <Mail className="h-3 w-3" />
    : channel === 'linkedin' || channel.startsWith('linkedin') ? <Linkedin className="h-3 w-3" />
    : channel === 'sms' ? <MessageCircle className="h-3 w-3" />
    : channel === 'phone' ? <PhoneCall className="h-3 w-3" />
    : null;
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground capitalize">{icon}{channel === 'linkedin' ? 'LinkedIn' : channel}</span>;
};

type ContactSortField = 'name' | 'title' | 'company' | 'lastReached' | 'lastResponded' | 'status' | 'updated';
type ContactSortDir = 'asc' | 'desc';

const Contacts = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: profiles = [] } = useProfiles();
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<ContactFilters>(DEFAULT_CONTACT_FILTERS);
  const [filterSidebarOpen, setFilterSidebarOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedContactSearch[]>(loadSavedContactSearches);
  const [sortField, setSortField] = useState<ContactSortField>('updated');
  const [sortDir, setSortDir] = useState<ContactSortDir>('desc');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fetchingHistoryId, setFetchingHistoryId] = useState<string | null>(null);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkDeleting(true);
    try {
      const { error } = await supabase.from('contacts').delete().in('id', selectedIds);
      if (error) { toast.error(error.message || 'Failed to delete contacts'); return; }
      toast.success(`${selectedIds.length} contact${selectedIds.length === 1 ? '' : 's'} deleted`);
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete contacts');
    } finally {
      setBulkDeleting(false);
    }
  };
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const { data: contacts = [], isLoading, isError, error, refetch } = useContacts();
  const { data: jobs = [] } = useJobs();

  const filteredContacts = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const list = contacts.filter((contact) => {
      const companyDisplay = ((contact as any).company_name || (contact.companies as any)?.name || '');
      const secondary: string[] = Array.isArray((contact as any).secondary_emails) ? (contact as any).secondary_emails : [];
      const matchesSearch = !q ||
        (contact.full_name ?? '').toLowerCase().includes(q) ||
        companyDisplay.toLowerCase().includes(q) ||
        (contact.title ?? '').toLowerCase().includes(q) ||
        ((contact as any).email ?? '').toLowerCase().includes(q) ||
        ((contact as any).work_email ?? '').toLowerCase().includes(q) ||
        ((contact as any).personal_email ?? '').toLowerCase().includes(q) ||
        secondary.some((e) => (e ?? '').toLowerCase().includes(q));
      const matchesStatus = filters.status === 'all' || contact.status === filters.status;

      const roles: string[] = (contact as any).roles ?? ['client'];
      const matchesRole =
        filters.role === 'all' ? true :
        filters.role === 'client_only' ? (roles.includes('client') && !roles.includes('candidate')) :
        filters.role === 'also_candidate' ? (roles.includes('candidate')) :
        true;

      // Owner
      const ownerId = (contact as any).owner_user_id;
      const matchesOwner =
        filters.owner === 'all' ? true :
        filters.owner === 'mine' ? ownerId === user?.id :
        ownerId === filters.owner;

      // Company / Title (partial, case-insensitive)
      const companyText = ((contact as any).company_name || (contact.companies as any)?.name || '').toLowerCase();
      const matchesCompany = !filters.company || companyText.includes(filters.company.toLowerCase());
      const matchesTitle = !filters.title || (contact.title ?? '').toLowerCase().includes(filters.title.toLowerCase());

      // Last sentiment / channel
      const matchesSentiment = filters.sentiment === 'all' || (contact as any).last_sequence_sentiment === filters.sentiment;
      const matchesChannel = filters.channel === 'all' || (contact as any).last_comm_channel === filters.channel;

      // Last reached out — before/after (uses the view's last_reached_out_at)
      const reachedAt = (contact as any).last_reached_out_at ? new Date((contact as any).last_reached_out_at) : null;
      const matchesReachedFrom = !filters.lastReachedFrom || (reachedAt && reachedAt >= filters.lastReachedFrom);
      const matchesReachedTo = !filters.lastReachedTo || (reachedAt && reachedAt <= endOfDay(filters.lastReachedTo));

      // Last response — before/after
      const respondedAt = (contact as any).last_responded_at ? new Date((contact as any).last_responded_at) : null;
      const matchesRespondedFrom = !filters.lastRespondedFrom || (respondedAt && respondedAt >= filters.lastRespondedFrom);
      const matchesRespondedTo = !filters.lastRespondedTo || (respondedAt && respondedAt <= endOfDay(filters.lastRespondedTo));

      // Date added
      const createdAt = (contact as any).created_at ? new Date((contact as any).created_at) : null;
      const matchesAddedFrom = !filters.dateAddedFrom || (createdAt && createdAt >= filters.dateAddedFrom);
      const matchesAddedTo = !filters.dateAddedTo || (createdAt && createdAt <= endOfDay(filters.dateAddedTo));

      return matchesSearch && matchesStatus && matchesRole && matchesOwner &&
        matchesCompany && matchesTitle && matchesSentiment && matchesChannel &&
        matchesReachedFrom && matchesReachedTo && matchesRespondedFrom && matchesRespondedTo &&
        matchesAddedFrom && matchesAddedTo;
    });

    list.sort((a, b) => {
      let aVal: string = '';
      let bVal: string = '';
      switch (sortField) {
        case 'name':
          aVal = (a.full_name || '').toLowerCase();
          bVal = (b.full_name || '').toLowerCase();
          break;
        case 'title':
          aVal = (a.title || '').toLowerCase();
          bVal = (b.title || '').toLowerCase();
          break;
        case 'company':
          aVal = ((a as any).company_name || (a.companies as any)?.name || '').toLowerCase();
          bVal = ((b as any).company_name || (b.companies as any)?.name || '').toLowerCase();
          break;
        case 'status':
          aVal = a.status || '';
          bVal = b.status || '';
          break;
        case 'lastReached':
          aVal = (a as any).last_reached_out_at || '';
          bVal = (b as any).last_reached_out_at || '';
          break;
        case 'lastResponded':
          aVal = (a as any).last_responded_at || '';
          bVal = (b as any).last_responded_at || '';
          break;
        case 'updated':
          aVal = (a as any).updated_at || (a as any).created_at || '';
          bVal = (b as any).updated_at || (b as any).created_at || '';
          break;
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [contacts, searchQuery, filters, sortField, sortDir, user?.id]);

  // Reset page when filters change
  const totalPages = Math.ceil(filteredContacts.length / PAGE_SIZE);
  const paginatedContacts = filteredContacts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 when search or filter changes
  useEffect(() => { setPage(1); }, [searchQuery, filters]);

  // Saved-search handlers (localStorage-backed)
  const handleSaveSearch = (name: string) => {
    const newSearch: SavedContactSearch = {
      id: `cs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      filters: { ...filters },
      searchQuery,
      created_at: new Date().toISOString(),
    };
    const updated = [newSearch, ...savedSearches];
    setSavedSearches(updated);
    persistSavedContactSearches(updated);
    toast.success(`Saved search "${name}"`);
  };
  const handleLoadSearch = (search: SavedContactSearch) => {
    setFilters(search.filters);
    setSearchQuery(search.searchQuery);
    setPage(1);
    toast.success(`Loaded "${search.name}"`);
  };
  const handleDeleteSearch = (id: string) => {
    const updated = savedSearches.filter((s) => s.id !== id);
    setSavedSearches(updated);
    persistSavedContactSearches(updated);
  };

  const activeFilterCount = getActiveContactFilterCount(filters);
  const filterChips = getActiveContactFilterChips(filters, STATUS_LABELS, profiles);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    const pageIds = paginatedContacts.map((c) => c.id);
    if (pageIds.every((id) => selectedIds.includes(id))) {
      setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...pageIds])]);
    }
  };

  const toggleSort = (field: ContactSortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: ContactSortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const selectedNames = contacts
    .filter((c) => selectedIds.includes(c.id))
    .map((c) => c.full_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`);

  const handleQuickStatusChange = async (contactId: string, newStatus: string) => {
    try {
      const { error } = await supabase.from('contacts').update({ status: newStatus }).eq('id', contactId);
      if (error) throw new Error(error.message);
      toast.success(`Status updated to ${newStatus}`);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    }
  };

  const handleQuickDelete = async (contactId: string) => {
    try {
      const { error } = await supabase.from('contacts').delete().eq('id', contactId);
      if (error) throw new Error(error.message);
      toast.success('Contact deleted');
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete contact');
    }
  };

  return (
    <MainLayout>
      <div className="px-6 pt-6 lg:px-8">
      <PageHeader
        title="Contacts"
        count={filteredContacts.length}
        actions={
          <div className="flex items-center gap-2">
            {selectedIds.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
                  <Play className="h-3.5 w-3.5" />
                  Enroll in Sequence ({selectedIds.length})
                </Button>
                <EnrichButton
                  peopleIds={selectedIds}
                  invalidateKeys={[['contacts']]}
                />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={bulkDeleting}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete ({selectedIds.length})
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {selectedIds.length} contact{selectedIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the selected contacts. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleBulkDelete}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
            <ActionMenu
              label="Add Contact"
              leadingIcon={<Plus className="h-4 w-4" />}
              items={[
                {
                  key: 'individual',
                  label: 'Add individual',
                  description: 'Create one contact by hand',
                  icon: <User />,
                  onSelect: () => setAddOpen(true),
                },
                {
                  key: 'csv',
                  label: 'Import CSV',
                  description: 'Upload a spreadsheet of contacts',
                  icon: <Upload />,
                  onSelect: () => setImportOpen(true),
                },
              ]}
            />
          </div>
        }
      />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Filter Sidebar ─────────────────────────────────────────────── */}
        {filterSidebarOpen && (
          <ContactFilterSidebar
            filters={filters}
            onFiltersChange={(f) => { setFilters(f); setPage(1); }}
            onClose={() => setFilterSidebarOpen(false)}
            statusOptions={STATUS_OPTIONS}
            profiles={profiles}
            savedSearches={savedSearches}
            onSaveSearch={handleSaveSearch}
            onLoadSearch={handleLoadSearch}
            onDeleteSearch={handleDeleteSearch}
            searchQuery={searchQuery}
          />
        )}

        <div className="flex-1 overflow-y-auto bg-page-bg min-h-[calc(100vh-4rem)] p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Filter toggle */}
          <Button
            variant={filterSidebarOpen ? 'secondary' : 'outline'}
            size="sm"
            className="h-10 gap-1.5"
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

          <div className="relative flex-1 min-w-[16rem] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search contacts…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-xl border border-card-border bg-card text-foreground placeholder:text-muted-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {paginatedContacts.length > 0 && !paginatedContacts.every((c) => selectedIds.includes(c.id)) && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Select Page ({paginatedContacts.length})
            </Button>
          )}

          {paginatedContacts.length > 0 && paginatedContacts.every((c) => selectedIds.includes(c.id)) && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Deselect Page
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
                onClick={() => { setFilters(clearContactFilterByKey(filters, chip.key)); setPage(1); }}
              >
                {chip.label}
                <X className="h-3 w-3" />
              </Badge>
            ))}
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground ml-1 transition-colors"
              onClick={() => { setFilters(DEFAULT_CONTACT_FILTERS); setPage(1); }}
            >
              Clear all
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading contacts…
          </div>
        ) : isError ? (
          <div className="text-center py-16">
            <AlertCircle className="h-12 w-12 mx-auto text-destructive/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">Failed to load contacts</h3>
            <p className="text-sm text-muted-foreground mb-4">{(error as any)?.message || 'An error occurred while fetching contacts.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </div>
        ) : filteredContacts.length === 0 && !searchQuery && activeFilterCount === 0 ? (
          <div className="text-center py-16">
            <Users className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">No contacts yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Add your first contact or import a CSV to get started.</p>
            <Button variant="gold" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add Contact
            </Button>
          </div>
        ) : (
          <>
          <HorizontalTableScroll stickyHeader minWidth={1300} className="hidden md:block rounded-2xl border-card-border shadow-sm">
            <table className="w-full">
              <thead className="table-header-green sticky top-0 z-20">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={selectedIds.length === filteredContacts.length && filteredContacts.length > 0}
                      onCheckedChange={toggleAll}
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('name')}>
            <span className="flex items-center gap-1">Name <SortIcon field="name" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('title')}>
            <span className="flex items-center gap-1">Title <SortIcon field="title" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('company')}>
            <span className="flex items-center gap-1">Company <SortIcon field="company" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Contact Info</th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastReached')}>
            <span className="flex items-center gap-1">Last Reached Out <SortIcon field="lastReached" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastResponded')}>
            <span className="flex items-center gap-1">Last Response <SortIcon field="lastResponded" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('status')}>
            <span className="flex items-center gap-1">Status <SortIcon field="status" /></span>
          </th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Channel</th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Sentiment</th>
          <th className="text-left px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('updated')}>
            <span className="flex items-center gap-1">Updated <SortIcon field="updated" /></span>
          </th>
          <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {paginatedContacts.map((contact) => (
                  <tr key={contact.id} className="group hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => navigate(`/contacts/${contact.id}`)}>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.includes(contact.id)}
                        onCheckedChange={() => toggleSelect(contact.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <PersonAvatar
                          name={contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`}
                          src={(contact as any).profile_picture_url ?? (contact as any).avatar_url}
                          size="md"
                        />
                        <span className="text-sm font-medium text-foreground">
                          {contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`}
                        </span>
                        {(() => {
                          const roles: string[] = (contact as any).roles ?? ['client'];
                          return (
                            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                              {roles.includes('client') && (
                                <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium bg-accent/10 text-accent border border-accent/20">
                                  Client
                                </span>
                              )}
                              {roles.includes('candidate') && (
                                <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium bg-green-500/10 text-green-600 border border-green-500/20">
                                  Candidate
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{contact.title ?? '-'}</td>
                    <td className="px-4 py-3">
                      {(() => {
                        const companyName = (contact as any).company_name || (contact.companies as any)?.name || null;
                        const companyDomain = (contact.companies as any)?.domain ?? null;
                        return (companyName || (contact as any).company_id) ? (
                          <CompanyLink
                            companyId={(contact as any).company_id}
                            name={companyName}
                            domain={companyDomain}
                            showLogo
                            stopPropagation
                            className="text-sm text-muted-foreground"
                          />
                        ) : (
                          <span className="text-sm text-muted-foreground">-</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {((contact as any).work_email || contact.email) && (
                          <a href={`mailto:${(contact as any).work_email || contact.email}`}
                            title={`Work: ${(contact as any).work_email || contact.email}`}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                            <Mail className="h-4 w-4" />
                          </a>
                        )}
                        {(contact as any).personal_email && (
                          <a href={`mailto:${(contact as any).personal_email}`}
                            title={`Personal: ${(contact as any).personal_email}`}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground/50 hover:text-foreground transition-colors">
                            <Mail className="h-4 w-4" />
                          </a>
                        )}
                        {((contact as any).mobile_phone || contact.phone) && (
                          <a href={`tel:${(contact as any).mobile_phone || contact.phone}`}
                            title={(contact as any).mobile_phone || contact.phone}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                            <Phone className="h-4 w-4" />
                          </a>
                        )}
                        {contact.linkedin_url && (
                          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer"
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                            <Linkedin className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {(contact as any).last_reached_out_at
                        ? new Date((contact as any).last_reached_out_at).toLocaleDateString()
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {(contact as any).last_responded_at
                        ? new Date((contact as any).last_responded_at).toLocaleDateString()
                        : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide capitalize',
                        contact.status === 'engaged' || contact.status === 'active'
                          ? 'bg-success/10 text-success border-success/20'
                          : contact.status === 'reached_out'
                          ? 'bg-warning/15 text-warning border-warning/20'
                          : contact.status === 'new'
                          ? 'bg-primary/10 text-primary border-primary/20'
                          : 'bg-muted text-muted-foreground border-card-border'
                      )}>
                        {contact.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ChannelBadge channel={(contact as any).last_comm_channel} />
                    </td>
                    <td className="px-4 py-3">
                      {(contact as any).last_sequence_sentiment ? (() => {
                        const s = (contact as any).last_sequence_sentiment;
                        const cfg = SENTIMENT_CONFIG[s] ?? { label: s.replace(/_/g, ' '), bg: 'bg-muted', text: 'text-muted-foreground' };
                        return (
                          <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', cfg.bg, cfg.text)} title={(contact as any).last_sequence_sentiment_note || undefined}>
                            {cfg.label}
                          </span>
                        );
                      })() : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {(contact as any).updated_at ? format(new Date((contact as any).updated_at), 'MMM d, yyyy') : '—'}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => navigate(`/contacts/${contact.id}`)}>
                            <User className="h-3.5 w-3.5 mr-2" /> View Profile
                          </DropdownMenuItem>
                          {contact.email && (
                            <DropdownMenuItem onClick={() => window.open(`mailto:${contact.email}`)}>
                              <Mail className="h-3.5 w-3.5 mr-2" /> Send Email
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setTaskPanel({ id: contact.id, name: contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}` })}>
                            <ListTodo className="h-3.5 w-3.5 mr-2" /> Tasks
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={fetchingHistoryId === contact.id}
                            onClick={async () => {
                              setFetchingHistoryId(contact.id);
                              try {
                                const resp = await fetch('/api/trigger-fetch-history', {
                                  method: 'POST',
                                  headers: await authHeaders(),
                                  body: JSON.stringify({ contact_id: contact.id }),
                                });
                                const data = await resp.json();
                                if (data.error) throw new Error(data.error);
                                toast.success('History fetch triggered — messages will appear shortly');
                              } catch (err: any) {
                                toast.error(err.message || 'History fetch failed');
                              } finally {
                                setFetchingHistoryId(null);
                              }
                            }}
                          >
                            {fetchingHistoryId === contact.id ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <History className="h-3.5 w-3.5 mr-2" />}
                            Fetch History
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <RefreshCw className="h-3.5 w-3.5 mr-2" /> Change Status
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {['new', 'reached_out', 'engaged'].filter(s => s !== contact.status).map(s => (
                                <DropdownMenuItem key={s} onClick={() => handleQuickStatusChange(contact.id, s)}>
                                  {STATUS_LABELS[s] ?? s}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuItem onClick={() => { setSelectedIds([contact.id]); setEnrollOpen(true); }}>
                            <Play className="h-3.5 w-3.5 mr-2" /> Enroll in Sequence
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={togglingTagId === contact.id}
                            onSelect={(e) => { e.preventDefault(); }}
                            onClick={async () => {
                              if (togglingTagId === contact.id) return;
                              setTogglingTagId(contact.id);
                              const currentRoles: string[] = (contact as any).roles ?? ['client'];
                              const newRoles = currentRoles.includes('candidate')
                                ? currentRoles.filter((r: string) => r !== 'candidate')
                                : [...currentRoles, 'candidate'];
                              try {
                                const { error } = await supabase
                                  .from('contacts')
                                  .update({ roles: newRoles } as any)
                                  .eq('id', contact.id);
                                if (error) throw error;
                                toast.success(newRoles.includes('candidate') ? 'Tagged as Candidate' : 'Candidate tag removed');
                                queryClient.invalidateQueries({ queryKey: ['contacts'] });
                              } catch (err: any) {
                                toast.error(err?.message || 'Failed to update candidate tag');
                              } finally {
                                setTogglingTagId(null);
                              }
                            }}>
                            {((contact as any).roles ?? ['client']).includes('candidate')
                              ? '— Remove Candidate Tag'
                              : '+ Tag as Candidate'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => handleQuickDelete(contact.id)}>
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
          {/* Mobile: stacked cards instead of the wide table. */}
          <div className="md:hidden rounded-2xl border border-card-border shadow-sm overflow-hidden divide-y divide-card-border bg-card">
            {paginatedContacts.map((contact) => {
              const companyName = (contact as any).company_name || (contact.companies as any)?.name || '';
              const name = contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`;
              return (
                <div
                  key={contact.id}
                  className="flex items-center gap-3 px-4 py-3 active:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => navigate(`/contacts/${contact.id}`)}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selectedIds.includes(contact.id)} onCheckedChange={() => toggleSelect(contact.id)} />
                  </div>
                  <PersonAvatar name={name} src={(contact as any).profile_picture_url ?? (contact as any).avatar_url} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{name}</p>
                    <p className="text-xs text-muted-foreground truncate">{[contact.title, companyName].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <span className={cn(
                    'shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide capitalize',
                    contact.status === 'engaged' || contact.status === 'active'
                      ? 'bg-success/10 text-success border-success/20'
                      : contact.status === 'reached_out'
                      ? 'bg-warning/15 text-warning border-warning/20'
                      : contact.status === 'new'
                      ? 'bg-primary/10 text-primary border-primary/20'
                      : 'bg-muted text-muted-foreground border-card-border',
                  )}>
                    {contact.status}
                  </span>
                </div>
              );
            })}
            {paginatedContacts.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">No contacts match your filters.</div>
            )}
          </div>
          </>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-xs text-muted-foreground">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredContacts.length)} of {filteredContacts.length}
              {selectedIds.length > 0 && <span className="ml-2">({selectedIds.length} selected)</span>}
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
        </div>
      </div>
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} entityType="contacts" />
      <AddContactDialog open={addOpen} onOpenChange={setAddOpen} />
      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        candidateIds={selectedIds}
        candidateNames={selectedNames}
      />
      {taskPanel && (
        <TaskSlidePanel
          open={!!taskPanel}
          onOpenChange={(open) => !open && setTaskPanel(null)}
          entityType="contact"
          entityId={taskPanel.id}
          entityName={taskPanel.name}
        />
      )}
    </MainLayout>
  );
};

export default Contacts;
