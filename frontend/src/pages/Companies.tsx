import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useCompanies } from '@/hooks/useData';
import { Plus, Search, Globe, MapPin, Briefcase, ListTodo, MoreHorizontal, RefreshCw, Trash2, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AddCompanyDialog } from '@/components/companies/AddCompanyDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNavigate } from 'react-router-dom';

const Companies = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState<{ id: string; name: string } | null>(null);
  const { data: companies = [], isLoading } = useCompanies();

  const handleQuickTypeChange = async (companyId: string, newType: string) => {
    try {
      const { error } = await supabase.from('companies').update({ company_type: newType }).eq('id', companyId);
      if (error) throw new Error(error.message);
      toast.success(`Company type updated to ${newType}`);
      queryClient.invalidateQueries({ queryKey: ['companies'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update type');
    }
  };

  const handleQuickDelete = async (companyId: string) => {
    try {
      const { error } = await supabase.from('companies').delete().eq('id', companyId);
      if (error) throw new Error(error.message);
      toast.success('Company deleted');
      queryClient.invalidateQueries({ queryKey: ['companies'] });
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
        actions={
          <Button variant="gold" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Company
          </Button>
        }
      />
      
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search companies…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>All</Button>
            <Button variant={filter === 'client' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('client')}>Clients</Button>
            <Button variant={filter === 'target' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('target')}>Targets</Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading companies…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCompanies.map((company) => (
              <div
                key={company.id}
                className="rounded-lg border border-border bg-card p-5 hover:border-accent/50 transition-all duration-150 cursor-pointer hover-lift"
                onClick={() => navigate(`/companies/${company.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <CompanyLogo domain={company.domain} name={company.name} size="md" />
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{company.name}</h3>
                      <p className="text-xs text-muted-foreground">{company.company_type ?? '-'}</p>
                    </div>
                  </div>
                  {company.company_type && (
                    <span className={cn(
                      'stage-badge border',
                      company.company_type === 'client'
                        ? 'bg-success/10 text-success border-success/20'
                        : 'bg-warning/10 text-warning border-warning/20'
                    )}>
                      {company.company_type}
                    </span>
                  )}
                </div>

                <div className="space-y-2 text-sm text-muted-foreground">
                  {company.location && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5" />
                      {company.location}
                    </div>
                  )}
                  {company.domain && (
                    <div className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5" />
                      <span className="text-accent truncate">{company.domain}</span>
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Briefcase className="h-3 w-3" />
                    {company.job_count} active {company.job_count === 1 ? 'job' : 'jobs'}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="p-1 rounded hover:bg-muted transition-colors" onClick={(e) => e.stopPropagation()}>
                        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => setTaskPanel({ id: company.id, name: company.name })}>
                        <ListTodo className="h-3.5 w-3.5 mr-2" /> Tasks
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
