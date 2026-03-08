import { useState, useMemo } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { useProspects } from '@/hooks/useSupabaseData';
import { Plus, Search, Building, Play, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type SortField = 'name' | 'title' | 'company' | 'status' | 'location';
type SortDir = 'asc' | 'desc';

const statusFilters = ['all', 'new', 'reached_out', 'qualified', 'converted', 'disqualified'] as const;
const statusColors: Record<string, string> = {
  new: 'bg-info/10 text-info border-info/20',
  reached_out: 'bg-warning/10 text-warning border-warning/20',
  qualified: 'bg-success/10 text-success border-success/20',
  converted: 'bg-accent/10 text-accent border-accent/20',
  disqualified: 'bg-destructive/10 text-destructive border-destructive/20',
};

const Leads = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const { data: prospects = [], isLoading } = useProspects();

  const filteredProspects = useMemo(() => {
    let list = prospects.filter((p) => {
      const matchesSearch =
        (p.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.current_company ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.current_title ?? '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });

    list.sort((a, b) => {
      let aVal = '', bVal = '';
      switch (sortField) {
        case 'name': aVal = a.full_name ?? ''; bVal = b.full_name ?? ''; break;
        case 'title': aVal = a.current_title ?? ''; bVal = b.current_title ?? ''; break;
        case 'company': aVal = a.current_company ?? ''; bVal = b.current_company ?? ''; break;
        case 'status': aVal = a.status; bVal = b.status; break;
        case 'location': aVal = a.location ?? ''; bVal = b.location ?? ''; break;
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [prospects, searchQuery, statusFilter, sortField, sortDir]);

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
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    if (selectedIds.length === filteredProspects.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredProspects.map(p => p.id));
    }
  };

  const selectedNames = prospects
    .filter(p => selectedIds.includes(p.id))
    .map(p => p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`);

  return (
    <MainLayout>
      <PageHeader 
        title="Prospects" 
        description="Manage your pipeline of prospects."
        actions={
          <Button variant="gold">
            <Plus className="h-4 w-4" />
            Add Prospect
          </Button>
        }
      />
      
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search prospects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-1.5">
            {statusFilters.map((s) => (
              <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(s)} className="capitalize text-xs">
                {s === 'all' ? 'All' : s.replace('_', ' ')}
              </Button>
            ))}
          </div>

          {selectedIds.length > 0 && (
            <Button variant="gold" size="sm" onClick={() => setEnrollOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              Enroll {selectedIds.length} in Sequence
            </Button>
          )}
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading leads...</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={selectedIds.length === filteredProspects.length && filteredProspects.length > 0}
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
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none" onClick={() => toggleSort('location')}>
                    <span className="flex items-center gap-1">Location <SortIcon field="location" /></span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredProspects.map((prospect) => (
                  <tr key={prospect.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.includes(prospect.id)}
                        onCheckedChange={() => toggleSelect(prospect.id)}
                      />
                    </td>
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
                {filteredProspects.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No leads match your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        candidateIds={[]}
        prospectIds={selectedIds}
        candidateNames={selectedNames}
      />
    </MainLayout>
  );
};

export default Leads;
