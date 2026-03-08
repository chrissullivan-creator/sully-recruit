import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useProspects } from '@/hooks/useSupabaseData';
import { Plus, Search, Users, Building } from 'lucide-react';
import { cn } from '@/lib/utils';

const statusColors: Record<string, string> = {
  new: 'bg-info/10 text-info border-info/20',
  reached_out: 'bg-warning/10 text-warning border-warning/20',
  qualified: 'bg-success/10 text-success border-success/20',
  converted: 'bg-accent/10 text-accent border-accent/20',
  disqualified: 'bg-destructive/10 text-destructive border-destructive/20',
};

const Leads = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const { data: prospects = [], isLoading } = useProspects();

  const filteredProspects = prospects.filter((p) => {
    const matchesSearch = (p.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.current_company ?? '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || p.status === filter;
    return matchesSearch && matchesFilter;
  });

  return (
    <MainLayout>
      <PageHeader 
        title="Leads" 
        description="Manage your pipeline of prospects and leads."
        actions={
          <Button variant="gold">
            <Plus className="h-4 w-4" />
            Add Lead
          </Button>
        }
      />
      
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search leads..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>All</Button>
            <Button variant={filter === 'new' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('new')}>New</Button>
            <Button variant={filter === 'qualified' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('qualified')}>Qualified</Button>
            <Button variant={filter === 'converted' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('converted')}>Converted</Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading leads...</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredProspects.map((prospect) => (
                  <tr key={prospect.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                          {(prospect.first_name?.[0] ?? '')}{(prospect.last_name?.[0] ?? '')}
                        </div>
                        <div>
                          <span className="text-sm font-medium text-foreground">
                            {prospect.full_name ?? `${prospect.first_name ?? ''} ${prospect.last_name ?? ''}`}
                          </span>
                          {prospect.email && (
                            <p className="text-xs text-muted-foreground">{prospect.email}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{prospect.current_title ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Building className="h-3 w-3" />
                        {prospect.current_company ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('stage-badge border', statusColors[prospect.status] ?? 'bg-muted text-muted-foreground border-border')}>
                        {prospect.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{prospect.location ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
};

export default Leads;
