import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { AddCandidateDialog } from '@/components/candidates/AddCandidateDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { ApplicantsTab } from '@/components/people/ApplicantsTab';
import { EmailBounceBadge } from '@/components/shared/EmailBounceBadge';
import { usePeopleSearch, usePeopleTabCounts } from '@/hooks/useData';
import {
  Search, Mail, Phone, Linkedin, Play, ArrowUpDown, ArrowUp, ArrowDown,
  Loader2, MoreHorizontal, Trash2, AlertCircle, Users2, UserCheck, Users,
  MessageCircle, PhoneCall, RefreshCw, Plus, UserPlus, Briefcase, Upload,
} from 'lucide-react';
import { BulkCandidateActionsDialog } from '@/components/candidates/BulkCandidateActionsDialog';
import { cn } from '@/lib/utils';
import { invalidatePersonScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';
import { TableSkeleton, EmptyState } from '@/components/shared/EmptyState';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { CompanyLink } from '@/components/shared/EntityLinks';

type PersonTab = 'all' | 'candidates' | 'clients' | 'applicants';
type SortField = 'name' | 'title' | 'company' | 'lastReached' | 'lastResponded' | 'updated' | 'created';
type SortDir = 'asc' | 'desc';

const ChannelBadge = ({ channel }: { channel?: string | null }) => {
  if (!channel) return <span className="text-muted-foreground">—</span>;
  const icon = channel === 'email' ? <Mail className="h-3 w-3" />
    : channel.startsWith('linkedin') ? <Linkedin className="h-3 w-3" />
    : channel === 'sms' ? <MessageCircle className="h-3 w-3" />
    : channel === 'phone' ? <PhoneCall className="h-3 w-3" />
    : null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground capitalize">
      {icon}{channel.startsWith('linkedin') ? 'LinkedIn' : channel}
    </span>
  );
};

const RoleBadges = ({ roles, sourceTable }: { roles: string[] | null; sourceTable: string }) => {
  const r = roles ?? (sourceTable === 'candidate' ? ['candidate'] : ['client']);
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {r.includes('candidate') && (
        <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 border border-green-500/20">
          <UserCheck className="h-2.5 w-2.5" /> Candidate
        </span>
      )}
      {r.includes('client') && (
        <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-[#C9A84C]/10 text-[#C9A84C] border border-[#C9A84C]/20">
          <Users className="h-2.5 w-2.5" /> Client
        </span>
      )}
    </div>
  );
};

const TAB_CONFIG: { key: PersonTab; label: string }[] = [
  { key: 'all',        label: 'All People'  },
  { key: 'candidates', label: 'Candidates'  },
  { key: 'clients',    label: 'Clients'     },
  { key: 'applicants', label: 'Applicants'  },
];

const People = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [tab, setTab] = useState<PersonTab>('all');
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [bulkSendOutOpen, setBulkSendOutOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [addCandidateOpen, setAddCandidateOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  // Server-side search + pagination. The page used to download all ~14k people
  // and filter/sort/paginate in JS (slow to load; search only saw loaded rows).
  // Now the DB returns one ~100-row page per request, with trigram-indexed
  // search. Debounce the input so we don't fire a query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const { data: pageData, isLoading, isError, error, refetch } = usePeopleSearch({
    search: debouncedSearch, tab, sortField, sortDir, page, pageSize: PAGE_SIZE,
  });
  const rows = (pageData?.rows ?? []) as any[];
  const total = pageData?.total ?? 0;
  const { data: tabCountData } = usePeopleTabCounts();

  const rowKey = (p: any) => `${p.source_table}:${p.id}`;

  const getRoles = (p: any): string[] =>
    p.roles ?? (p.source_table === 'candidate' ? ['candidate'] : ['client']);

  const matchesTab = (p: any) => {
    const r = getRoles(p);
    if (tab === 'all')        return true;
    if (tab === 'candidates') return r.includes('candidate');
    if (tab === 'clients')    return r.includes('client');
    return true;
  };

  // Full-email queries get a server-side bypass. The client cache pages
  // through people in chunks of 1000; on a 13K-row tenant the user can
  // search for an email that hasn't loaded yet and see "no results"
  // even though the row exists. When the input parses as a complete
  // email, we hit the people table directly and merge the rows in.
  const trimmedQuery = searchQuery.trim();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedQuery);
  const { data: emailHits = [] } = useQuery({
    queryKey: ['people_email_lookup', trimmedQuery.toLowerCase()],
    enabled: looksLikeEmail,
    queryFn: async () => {
      const lc = trimmedQuery.toLowerCase();
      // Three columns + a contains() for the secondary_emails text[] —
      // primary_email is generated, but we still match on it so legacy
      // rows that only have the COALESCE'd value still surface.
      const { data } = await supabase
        .from('people')
        .select(
          'id, type, full_name, first_name, last_name, ' +
          'title, current_title, company_name, current_company, company_id, ' +
          'work_email, personal_email, email:primary_email, secondary_emails, mobile_phone, phone, linkedin_url, ' +
          'email_invalid, email_invalid_reason, email_invalid_at, ' +
          'avatar_url, roles, status, ' +
          'last_contacted_at, last_responded_at, last_comm_channel, ' +
          'owner_user_id, created_at, updated_at',
        )
        .or(
          `primary_email.ilike.${lc},work_email.ilike.${lc},personal_email.ilike.${lc},secondary_emails.cs.{${lc}}`,
        )
        .limit(50);
      return (data ?? []).map((p: any) => ({
        ...p,
        source_table: p.type === 'client' ? 'contact' : 'candidate',
        title: p.title ?? p.current_title ?? null,
        company_name: p.company_name ?? p.current_company ?? null,
      }));
    },
    staleTime: 30_000,
  });

  // Server already filtered + sorted + paged; expose under the names the
  // render uses (paginated = the current server page).
  const filtered = rows;
  const paginated = rows;

  const { data: applicantCount = 0 } = useQuery({
    queryKey: ['applicants_count'],
    queryFn: async () => {
      const { count } = await supabase.from('applicants' as any).select('id', { count: 'exact', head: true });
      return count ?? 0;
    },
  });

  const tabCounts = {
    all:        tabCountData?.all ?? 0,
    candidates: tabCountData?.candidates ?? 0,
    clients:    tabCountData?.clients ?? 0,
    applicants: applicantCount,
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => { setPage(1); }, [debouncedSearch, tab, sortField, sortDir]);

  const toggleSelect = (key: string) =>
    setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const toggleAll = () => {
    const pageKeys = paginated.map(rowKey);
    if (pageKeys.every(k => selectedKeys.includes(k)))
      setSelectedKeys(prev => prev.filter(k => !pageKeys.includes(k)));
    else
      setSelectedKeys(prev => [...new Set([...prev, ...pageKeys])]);
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  // Pass every selection (candidate + contact rows) to enroll/bulk
  // dialogs. The dialog itself determines candidate-vs-contact routing
  // by looking each id up in the candidates list.
  const selectedCandidateIds = selectedKeys.map(k => k.split(':')[1]);
  // Send-out actions still gate on type=candidate (you can't send out
  // a client). Keep that subset separate.
  const selectedCandidateOnlyIds = selectedKeys
    .filter(k => k.startsWith('candidate:'))
    .map(k => k.split(':')[1]);

  const handleRowClick = (p: any) => {
    navigate(p.source_table === 'candidate' ? `/candidates/${p.id}` : `/contacts/${p.id}`);
  };

  const handleBulkDelete = async () => {
    if (!selectedKeys.length) return;
    setBulkDeleting(true);
    try {
      const candIds = selectedKeys.filter(k => k.startsWith('candidate:')).map(k => k.split(':')[1]);
      const contIds = selectedKeys.filter(k => k.startsWith('contact:')).map(k => k.split(':')[1]);
      // Both candidates and contacts live in the unified `people` table
      // (contacts is a backwards-compat view). Soft-delete in one shot.
      const allIds = [...candIds, ...contIds];
      if (allIds.length) {
        const { error } = await softDelete('people', allIds);
        if (error) throw new Error(error.message);
      }
      toast.success(`${selectedKeys.length} record${selectedKeys.length === 1 ? '' : 's'} deleted`);
      setSelectedKeys([]);
      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="People"
        description="Everyone in your network — candidates, clients, and the people who are both."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate('/people/import')} className="gap-1.5">
              <Upload className="h-3.5 w-3.5" /> Bulk Import
            </Button>
            {selectedKeys.length > 0 && (
              <>
                {selectedCandidateOnlyIds.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setBulkSendOutOpen(true)}>
                    <Briefcase className="h-3.5 w-3.5 mr-1" /> Add to Job ({selectedCandidateOnlyIds.length})
                  </Button>
                )}
                {selectedCandidateIds.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
                    <Play className="h-3.5 w-3.5 mr-1" /> Enroll ({selectedCandidateIds.length})
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={bulkDeleting}>
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete ({selectedKeys.length})
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {selectedKeys.length} record{selectedKeys.length === 1 ? '' : 's'}?</AlertDialogTitle>
                      <AlertDialogDescription>This permanently removes the selected people. Cannot be undone.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleBulkDelete}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="gold" size="sm">
                  <Plus className="h-4 w-4 mr-1" /> Add Person
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setAddCandidateOpen(true)}>
                  <UserCheck className="h-3.5 w-3.5 mr-2" /> Add Candidate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAddContactOpen(true)}>
                  <UserPlus className="h-3.5 w-3.5 mr-2" /> Add Contact
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div className="p-8">
        {/* Tabs */}
        <div className="flex items-center gap-0 mb-5 border-b border-border">
          {TAB_CONFIG.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
                tab === t.key
                  ? 'border-sidebar-primary text-sidebar-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              <span className={cn('ml-1.5 text-xs tabular-nums', tab === t.key ? 'text-sidebar-primary' : 'text-muted-foreground/60')}>
                {tabCounts[t.key]}
              </span>
            </button>
          ))}
        </div>

        {tab === 'applicants' ? (
          <ApplicantsTab />
        ) : (
        <>
        {/* Search + page select */}
        <div className="flex items-center gap-4 mb-5">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search name, company, title, email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {paginated.length > 0 && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {paginated.every(p => selectedKeys.includes(rowKey(p))) ? 'Deselect Page' : `Select Page (${paginated.length})`}
            </Button>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : isError ? (
          <div className="text-center py-16">
            <AlertCircle className="h-12 w-12 mx-auto text-destructive/40 mb-4" />
            <h3 className="text-lg font-medium mb-1">Failed to load</h3>
            <p className="text-sm text-muted-foreground mb-4">{(error as any)?.message}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Users2 className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium mb-1">No people found</h3>
            <p className="text-sm text-muted-foreground">Try a different filter or search term.</p>
          </div>
        ) : (
          <HorizontalTableScroll className="rounded-lg border border-border overflow-hidden" minWidth={1300}>
            <table className="w-full">
              <thead className="table-header-green">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={paginated.length > 0 && paginated.every(p => selectedKeys.includes(rowKey(p)))}
                      onCheckedChange={toggleAll}
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('name')}>
                    <span className="flex items-center gap-1">Name <SortIcon field="name" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Role</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('title')}>
                    <span className="flex items-center gap-1">Title <SortIcon field="title" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('company')}>
                    <span className="flex items-center gap-1">Company <SortIcon field="company" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastReached')}>
                    <span className="flex items-center gap-1">Last Reached <SortIcon field="lastReached" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastResponded')}>
                    <span className="flex items-center gap-1">Last Response <SortIcon field="lastResponded" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Channel</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('created')}>
                    <span className="flex items-center gap-1">Date Added <SortIcon field="created" /></span>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('updated')}>
                    <span className="flex items-center gap-1">Updated <SortIcon field="updated" /></span>
                  </th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paginated.map((person: any) => {
                  const key = rowKey(person);
                  const displayName = person.full_name ??
                    (`${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() || '—');
                  const initials = (
                    (person.first_name?.[0] ?? '') + (person.last_name?.[0] ?? '')
                  ).toUpperCase() || displayName[0]?.toUpperCase() || '?';

                  return (
                    <tr
                      key={key}
                      className="group hover:bg-muted/50 transition-colors cursor-pointer"
                      onClick={() => handleRowClick(person)}
                    >
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selectedKeys.includes(key)} onCheckedChange={() => toggleSelect(key)} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {person.avatar_url ? (
                            <img src={person.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                          ) : (
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-medium text-accent">
                              {initials}
                            </div>
                          )}
                          <span className="text-sm font-medium text-foreground">{displayName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadges roles={person.roles} sourceTable={person.source_table} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{person.title ?? '—'}</td>
                      <td className="px-4 py-3">
                        {(person.company_name || person.company_id) ? (
                          <CompanyLink
                            companyId={person.company_id}
                            name={person.company_name}
                            showLogo
                            stopPropagation
                            className="text-sm text-muted-foreground"
                          />
                        ) : (
                          <span className="text-sm text-muted-foreground flex items-center gap-2">
                            <CompanyLogo name="" domain={null} size="xs" />—
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          {person.work_email && (
                            <a href={`mailto:${person.work_email}`} title={`Work: ${person.work_email}`}
                              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                              <Mail className="h-4 w-4" />
                            </a>
                          )}
                          {person.personal_email && (
                            <a href={`mailto:${person.personal_email}`} title={`Personal: ${person.personal_email}`}
                              className="p-1.5 rounded hover:bg-muted text-muted-foreground/50 hover:text-foreground transition-colors">
                              <Mail className="h-4 w-4" />
                            </a>
                          )}
                          <EmailBounceBadge
                            emailInvalid={(person as any).email_invalid}
                            reason={(person as any).email_invalid_reason}
                            invalidatedAt={(person as any).email_invalid_at}
                            variant="icon"
                            className="ml-0.5"
                          />
                          {person.mobile_phone && (
                            <a href={`tel:${person.mobile_phone}`} title={person.mobile_phone}
                              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                              <Phone className="h-4 w-4" />
                            </a>
                          )}
                          {person.linkedin_url && (
                            <a href={person.linkedin_url} target="_blank" rel="noopener noreferrer"
                              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                              <Linkedin className="h-4 w-4" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {person.last_contacted_at ? new Date(person.last_contacted_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {person.last_responded_at ? new Date(person.last_responded_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <ChannelBadge channel={person.last_comm_channel} />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {person.created_at ? format(new Date(person.created_at), 'MMM d, yyyy') : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {person.updated_at ? format(new Date(person.updated_at), 'MMM d, yyyy') : '—'}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100">
                              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onClick={() => handleRowClick(person)}>View Profile</DropdownMenuItem>
                            {person.work_email && (
                              <DropdownMenuItem onClick={() => window.open(`mailto:${person.work_email}`)}>
                                Email (Work)
                              </DropdownMenuItem>
                            )}
                            {person.personal_email && (
                              <DropdownMenuItem onClick={() => window.open(`mailto:${person.personal_email}`)}>
                                Email (Personal)
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={async () => {
                                const { error } = await softDelete('people', person.id);
                                if (error) { toast.error(error.message); return; }
                                toast.success('Moved to trash — undo from /audit/trash within 30 days');
                                invalidatePersonScope(queryClient);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </HorizontalTableScroll>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-xs text-muted-foreground">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              {selectedKeys.length > 0 && <span className="ml-2">({selectedKeys.length} selected)</span>}
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
        candidateIds={selectedCandidateIds}
        candidateNames={selectedCandidateIds.map(id => {
          const p = rows.find((x: any) => x.id === id && x.source_table === 'candidate');
          return p?.full_name ?? id;
        })}
      />

      <BulkCandidateActionsDialog
        open={bulkSendOutOpen}
        onOpenChange={setBulkSendOutOpen}
        candidateIds={selectedCandidateOnlyIds}
        candidateNames={selectedCandidateOnlyIds.map(id => {
          const p = rows.find((x: any) => x.id === id && x.source_table === 'candidate');
          return p?.full_name ?? id;
        })}
      />

      <AddCandidateDialog open={addCandidateOpen} onOpenChange={setAddCandidateOpen} />
      <AddContactDialog open={addContactOpen} onOpenChange={setAddContactOpen} />
    </MainLayout>
  );
};

export default People;
