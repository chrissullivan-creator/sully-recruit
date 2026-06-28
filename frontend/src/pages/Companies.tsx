import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SectionCard } from '@/components/shared/SectionCard';
import { Button } from '@/components/ui/button';
import { useCompanies } from '@/hooks/useData';
import { Plus, Search, Globe, MapPin, Briefcase, Building, ListTodo, MoreHorizontal, RefreshCw, Trash2, Rss, Loader2 } from 'lucide-react';
import { authHeaders } from '@/lib/api-auth';
import { Checkbox } from '@/components/ui/checkbox';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { cn } from '@/lib/utils';
import { invalidateCompanyScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';
import { CardGridSkeleton, EmptyState } from '@/components/shared/EmptyState';
import { AddCompanyDialog } from '@/components/companies/AddCompanyDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNavigate, useSearchParams } from 'react-router-dom';

// Sidebar deep-links pass ?filter=clients|targets; map them to the page's
// existing All/Clients/Targets filter state (which keys on company_type).
const URL_TO_FILTER: Record<string, string> = { clients: 'client', targets: 'target' };
const FILTER_TO_URL: Record<string, string> = { client: 'clients', target: 'targets' };

const Companies = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = URL_TO_FILTER[searchParams.get('filter') ?? ''] ?? 'all';
  const setFilter = (next: string) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === 'all') params.delete('filter');
      else params.set('filter', FILTER_TO_URL[next] ?? next);
      return params;
    }, { replace: true });
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkFetching, setBulkFetching] = useState(false);
  const { data: companies = [], isLoading } = useCompanies();

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleBulkFetchPostings = async () => {
    if (selectedIds.length === 0) return;
    setBulkFetching(true);
    try {
      const res = await fetch('/api/companies/fetch-job-postings', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ companyIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk fetch failed');
      const newTotal = data.counts?.new_postings ?? 0;
      const okCount = (data.results ?? []).filter((r: any) => r.ok).length;
      const failed = (data.results ?? []).filter((r: any) => !r.ok).length;
      toast.success(
        `${newTotal} new posting${newTotal === 1 ? '' : 's'} across ${okCount} compan${okCount === 1 ? 'y' : 'ies'}` +
        (failed > 0 ? ` (${failed} failed)` : ''),
      );
      setSelectedIds([]);
    } catch (err: any) {
      toast.error(err.message || 'Bulk fetch failed');
    } finally {
      setBulkFetching(false);
    }
  };

  const handleQuickTypeChange = async (companyId: string, newType: string) => {
    try {
      const { error } = await supabase.from('companies').update({ company_type: newType }).eq('id', companyId);
      if (error) throw new Error(error.message);
      toast.success(`Company type updated to ${newType}`);
      invalidateCompanyScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update type');
    }
  };

  const handleFetchPostings = async (companyId: string, companyName: string) => {
    try {
      const res = await fetch('/api/companies/fetch-job-postings', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ companyIds: [companyId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fetch failed');
      const r = data.results?.[0];
      if (!r?.ok) {
        toast.error(`${companyName}: ${r?.error || 'no career URLs and no domain'}`);
        return;
      }
      toast.success(`${companyName}: ${r.new_postings} new posting${r.new_postings === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({ queryKey: ['company_job_postings', companyId] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to fetch postings');
    }
  };

  const handleQuickDelete = async (companyId: string) => {
    try {
      const { error } = await softDelete('companies', companyId).then(({ error }) => ({ error: error ? new Error(error.message) : null }));
      if (error) throw new Error(error.message);
      toast.success('Company deleted');
      invalidateCompanyScope(queryClient);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete company');
    }
  };

  const filteredCompanies = companies.filter((company) => {
    const matchesFilter = filter === 'all' || company.company_type === filter;
    const matchesSearch = company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (company.domain ?? '').toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Companies"
        description="Manage your client companies and target accounts."
        eyebrow="Accounts"
        icon={<Building />}
        actions={
          <Button variant="gold" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Company
          </Button>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="relative flex-1 min-w-[16rem] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search companies…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-xl border border-card-border bg-card text-foreground placeholder:text-muted-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="inline-flex items-center gap-1 rounded-xl border border-card-border bg-card p-1 shadow-sm">
            {([['all', 'All'], ['client', 'Clients'], ['target', 'Targets']] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {selectedIds.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{selectedIds.length} selected</span>
              <Button size="sm" variant="outline" onClick={() => setSelectedIds([])} disabled={bulkFetching}>
                Clear
              </Button>
              <Button size="sm" variant="gold" onClick={handleBulkFetchPostings} disabled={bulkFetching}>
                {bulkFetching
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  : <Rss className="h-3.5 w-3.5 mr-1.5" />}
                Fetch postings ({selectedIds.length})
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <CardGridSkeleton cards={6} />
        ) : filteredCompanies.length === 0 && !searchQuery ? (
          <EmptyState
            icon={Building}
            title="No companies yet"
            description="Track every client, target, and prospect. Add a company to start associating jobs and contacts."
            action={{ label: 'Add Company', icon: Plus, onClick: () => setAddOpen(true) }}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCompanies.map((company) => (
              <div
                key={company.id}
                className={cn(
                  "group rounded-2xl border bg-card p-5 shadow-sm transition-all duration-150 cursor-pointer hover:shadow-md hover:-translate-y-0.5",
                  selectedIds.includes(company.id) ? "border-accent ring-1 ring-accent/30" : "border-card-border",
                )}
                onClick={() => navigate(`/companies/${company.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.includes(company.id)}
                        onCheckedChange={() => toggleSelect(company.id)}
                        className="h-4 w-4"
                      />
                    </div>
                    <CompanyLogo
                      logoUrl={company.logo_url}
                      domain={company.domain}
                      name={company.name}
                      size="md"
                    />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground truncate">{company.name}</h3>
                      <p className="text-xs text-muted-foreground truncate">{company.industry || company.company_type || '-'}</p>
                    </div>
                  </div>
                  {company.company_type && (
                    <span className={cn(
                      'shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      company.company_type === 'client'
                        ? 'bg-success/10 text-success border-success/20'
                        : 'bg-accent/10 text-accent border-accent/20'
                    )}>
                      {company.company_type}
                    </span>
                  )}
                </div>

                <div className="space-y-2 text-sm text-muted-foreground">
                  {company.location && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{company.location}</span>
                    </div>
                  )}
                  {company.domain && (
                    <div className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                      <span className="text-primary truncate">{company.domain}</span>
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-card-border flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Briefcase className="h-3.5 w-3.5" />
                    {company.job_count} active {company.job_count === 1 ? 'job' : 'jobs'}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="p-1 rounded-lg hover:bg-muted transition-colors opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => setTaskPanel({ id: company.id, name: company.name })}>
                        <ListTodo className="h-3.5 w-3.5 mr-2" /> Tasks
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleFetchPostings(company.id, company.name)}>
                        <Rss className="h-3.5 w-3.5 mr-2" /> Fetch postings
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <RefreshCw className="h-3.5 w-3.5 mr-2" /> Change Type
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {['client', 'target'].filter(t => t !== company.company_type).map(t => (
                            <DropdownMenuItem key={t} onClick={() => handleQuickTypeChange(company.id, t)}>
                              {t.charAt(0).toUpperCase() + t.slice(1)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => handleQuickDelete(company.id)}>
                        <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <AddCompanyDialog open={addOpen} onOpenChange={setAddOpen} />
      {taskPanel && (
        <TaskSlidePanel
          open={!!taskPanel}
          onOpenChange={(open) => !open && setTaskPanel(null)}
          entityType="company"
          entityId={taskPanel.id}
          entityName={taskPanel.name}
        />
      )}
    </MainLayout>
  );
};

export default Companies;
