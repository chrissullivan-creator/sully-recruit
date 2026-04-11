import { useState, useMemo } from 'react';
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
import { Plus, Search, Phone, Mail, Linkedin, Upload, ListTodo, Play, Sparkles, ArrowUpDown, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

type ContactSortField = 'name' | 'title' | 'company' | 'lastReached' | 'lastResponded' | 'status';
type ContactSortDir = 'asc' | 'desc';

const Contacts = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [sortField, setSortField] = useState<ContactSortField>('name');
  const [sortDir, setSortDir] = useState<ContactSortDir>('asc');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [contactSearchOpen, setContactSearchOpen] = useState(false);
  const { data: contacts = [], isLoading } = useContacts();
  const { data: jobs = [] } = useJobs();
  const queryClient = useQueryClient();
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

  const filteredContacts = useMemo(() => {
    let list = contacts.filter((contact) => {
      const companyDisplay = ((contact as any).company_name || (contact.companies as any)?.name || '');
      const matchesSearch =
        (contact.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        companyDisplay.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (contact.title ?? '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesFilter = filter === 'all' || contact.status === filter;
      return matchesSearch && matchesFilter;
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
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [contacts, searchQuery, filter, sortField, sortDir]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === filteredContacts.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredContacts.map((c) => c.id));
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

          {filteredContacts.length > 0 && selectedIds.length !== filteredContacts.length && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Add All ({filteredContacts.length})
            </Button>
          )}

          {selectedIds.length === filteredContacts.length && filteredContacts.length > 0 && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              Deselect All
            </Button>
          )}
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading contacts…</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
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
          <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredContacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-muted/50 transition-colors">
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selectedIds.includes(contact.id)}
                        onCheckedChange={() => toggleSelect(contact.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-medium text-accent">
                          {(contact.first_name?.[0] ?? '')}{(contact.last_name?.[0] ?? '')}
                        </div>
                        <span className="text-sm font-medium text-foreground">
                          {contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`}
                        </span>
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
                      <div className="flex items-center gap-2">
                        {contact.email && (
                          <a href={`mailto:${contact.email}`} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                            <Mail className="h-4 w-4" />
                          </a>
                        )}
                        {contact.phone && (
                          <a href={`tel:${contact.phone}`} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                            <Phone className="h-4 w-4" />
                          </a>
                        )}
                        {contact.linkedin_url && (
                          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
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
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); setTaskPanel({ id: contact.id, name: contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}` }); }}>
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
