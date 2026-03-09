import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { useContacts } from '@/hooks/useSupabaseData';
import { Plus, Search, Building, Phone, Mail, Linkedin, Upload, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';

const Contacts = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const { data: contacts = [], isLoading } = useContacts();

  const filteredContacts = contacts.filter((contact) => {
    const matchesSearch = 
      (contact.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      ((contact.companies as any)?.name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (contact.title ?? '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || contact.status === filter;
    return matchesSearch && matchesFilter;
  });

  return (
    <MainLayout>
      <PageHeader 
        title="Contacts" 
        description="Your network of hiring managers, HR leaders, and decision makers."
        actions={
          <div className="flex items-center gap-2">
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
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>All</Button>
            <Button variant={filter === 'active' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('active')}>Active</Button>
            <Button variant={filter === 'inactive' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('inactive')}>Inactive</Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading contacts...</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact Info</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Reached Out</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Response</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="w-10 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredContacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
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
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Building className="h-3.5 w-3.5" />
                        {(contact.companies as any)?.name ?? '-'}
                      </span>
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
