import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { AskJoeAdvancedSearch } from '@/components/candidates/AskJoeAdvancedSearch';
import { AskJoeContactSearch } from '@/components/contacts/AskJoeContactSearch';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { useContacts, useJobs } from '@/hooks/useData';
import { Plus, Search, Building, Phone, Mail, Linkedin, Upload, ListTodo, Play, Sparkles, ArrowUpDown, ArrowUp, ArrowDown, MessageCircle, PhoneCall, History, Loader2, MoreHorizontal, User, Users, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { CompanyLogo } from '@/components/shared/CompanyLogo';

const SENTIMENT_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  interested:       { label: 'Interested',       bg: 'bg-[#2A5C42]',    text: 'text-white' },
  positive:         { label: 'Positive',         bg: 'bg-green-500/15', text: 'text-green-500' },
  maybe:            { label: 'Maybe',            bg: 'bg-[#C9A84C]/15', text: 'text-[#C9A84C]' },
  neutral:          { label: 'Neutral',          bg: 'bg-gray-500/15',  text: 'text-gray-400' },
  negative:         { label: 'Negative',         bg: 'bg-orange-500/15', text: 'text-orange-500' },
  not_interested:   { label: 'Not Interested',   bg: 'bg-red-500/15',   text: 'text-red-500' },
  do_not_contact:   { label: 'Do Not Contact',   bg: 'bg-red-900/20',   text: 'text-red-700' },
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
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'client_only' | 'also_candidate'>('all');
  const [sortField, setSortField] = useState<ContactSortField>('updated');
  const [sortDir, setSortDir] = useState<ContactSortDir>('desc');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [contactSearchOpen, setContactSearchOpen] = useState(false);
  const [fetchingHistoryId, setFetchingHistoryId] = useState<string | null>(null);
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
    let list = contacts.filter((contact) => {
      const companyDisplay = ((contact as any).company_name || (contact.companies as any)?.name || '');
      const matchesSearch =
        (contact.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        companyDisplay.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (contact.title ?? '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesFilter = filter === 'all' || contact.status === filter;
      const roles: string[] = (contact as any).roles ?? ['client'];
      const matchesRole =
        roleFilter === 'all' ? true :
        roleFilter === 'client_only' ? (roles.includes('client') && !roles.includes('candidate')) :
        roleFilter === 'also_candidate' ? (roles.includes('candidate')) :
        true;
      return matchesSearch && matchesFilter && matchesRole;
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
  }, [contacts, searchQuery, filter, sortField, sortDir]);

  // Reset page when filters change
  const totalPages = Math.ceil(filteredContacts.length / PAGE_SIZE);
  const paginatedContacts = filteredContacts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 when search or filter changes
  useEffect(() => { setPage(1); }, [searchQuery, filter, roleFilter]);

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

  // Called by AskJoeContactSearch when user clicks "Enroll X Contacts in Sequence"
  const handleJoeEnroll = (contactIds: string[]) => {
    setSelectedIds(contactIds);
    setEnrollOpen(true);
  };

  return (
    <MainLayout>
      <PageHeader 
        title="Contacts" 
        description="Your network of hiring managers, HR leaders, and decision makers."
        actions={
          <div className="flex items-center gap-2">
            {selectedIds.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
                  <Play className="h-3.5 w-3.5" />
                  Enroll in Sequence ({selectedIds.length})
                </Button>
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
            <Button variant="ghost" size="sm" onClick={() => setAdvancedSearchOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1" />
              Ask Joe — Firm & Title Search
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setContactSearchOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1" />
              Ask Joe — Contacts
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1" />
              Import CSV
            </Button>
            <Button variant="gold" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Contact
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
              placeholder="Search contacts…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Status:</span>
            <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>All</Button>
            <Button variant={filter === 'active' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('active')}>Active</Button>
            <Button variant={filter === 'inactive' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('inactive')}>Inactive</Button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Role:</span>
            <Button variant={roleFilter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setRoleFilter('all')}>All</Button>
            <Button variant={roleFilter === 'client_only' ? 'secondary' : 'ghost'} size="sm" onClick={() => setRoleFilter('client_only')}>Client only</Button>
            <Button variant={roleFilter === 'also_candidate' ? 'secondary' : 'ghost'} size="sm" onClick={() => setRoleFilter('also_candidate')}>Also a Candidate</Button>
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
        ) : filteredContacts.length === 0 && !searchQuery && filter === 'all' ? (
          <div className="text-center py-16">
            <Users className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">No contacts yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Add your first contact or import a CSV to get started.</p>
            <Button variant="gold" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add Contact
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="table-header-green">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={selectedIds.length === filteredContacts.length && filteredContacts.length > 0}
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
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact Info</th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastReached')}>
            <span className="flex items-center gap-1">Last Reached Out <SortIcon field="lastReached" /></span>
          </th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('lastResponded')}>
            <span className="flex items-center gap-1">Last Response <SortIcon field="lastResponded" /></span>
          </th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('status')}>
            <span className="flex items-center gap-1">Status <SortIcon field="status" /></span>
          </th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Channel</th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Sentiment</th>
          <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('updated')}>
            <span className="flex items-center gap-1">Updated <SortIcon field="updated" /></span>
          </th>
          <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
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
                        {(contact as any).avatar_url ? (
                          <img src={(contact as any).avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-medium text-accent">
                            {(contact.first_name?.[0] ?? '')}{(contact.last_name?.[0] ?? '')}
                          </div>
                        )}
                        <span className="text-sm font-medium text-foreground">
                          {contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`}
                        </span>
                        {(() => {
                          const roles: string[] = (contact as any).roles ?? ['client'];
                          return (
                            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                              {roles.includes('client') && (
                                <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium bg-[#C9A84C]/10 text-[#C9A84C] border border-[#C9A84C]/20">
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
                        const companyName = (contact as any).company_name || (contact.companies as any)?.name || '-';
                        const companyDomain = (contact.companies as any)?.domain ?? null;
                        return (
                          <span className="text-sm text-muted-foreground flex items-center gap-2">
                            <CompanyLogo name={companyName} domain={companyDomain} size="xs" />
                            {companyName}
                          </span>
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
                        'stage-badge border',
                        contact.status === 'active' 
                          ? 'bg-success/10 text-success border-success/20' 
                          : 'bg-muted text-muted-foreground border-border'
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
                                  headers: { 'Content-Type': 'application/json' },
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
                              {['active', 'inactive'].filter(s => s !== contact.status).map(s => (
                                <DropdownMenuItem key={s} onClick={() => handleQuickStatusChange(contact.id, s)}>
                                  {s.charAt(0).toUpperCase() + s.slice(1)}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuItem onClick={() => { setSelectedIds([contact.id]); setEnrollOpen(true); }}>
                            <Play className="h-3.5 w-3.5 mr-2" /> Enroll in Sequence
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={async () => {
                            const currentRoles: string[] = (contact as any).roles ?? ['client'];
                            const newRoles = currentRoles.includes('candidate')
                              ? currentRoles.filter((r: string) => r !== 'candidate')
                              : [...currentRoles, 'candidate'];
                            await supabase.from('contacts').update({ roles: newRoles } as any).eq('id', contact.id);
                            toast.success(newRoles.includes('candidate') ? 'Tagged as Candidate' : 'Candidate tag removed');
                            queryClient.invalidateQueries({ queryKey: ['contacts'] });
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
          </div>
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
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} entityType="contacts" />
      <AddContactDialog open={addOpen} onOpenChange={setAddOpen} />
      <AskJoeAdvancedSearch open={advancedSearchOpen} onOpenChange={setAdvancedSearchOpen} mode="contact_search" />
      <AskJoeContactSearch
        open={contactSearchOpen}
        onOpenChange={setContactSearchOpen}
        onEnrollContacts={handleJoeEnroll}
      />
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
