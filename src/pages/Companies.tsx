import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useCompanies } from '@/hooks/useSupabaseData';
import { Plus, Search, Building, Globe, MapPin, Briefcase } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AddCompanyDialog } from '@/components/companies/AddCompanyDialog';

const Companies = () => {
  const [filter, setFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { data: companies = [], isLoading } = useCompanies();

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
          <Button variant="gold">
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
              placeholder="Search companies..."
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
          <p className="text-muted-foreground text-sm">Loading companies...</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCompanies.map((company) => (
              <div
                key={company.id}
                className="rounded-lg border border-border bg-card p-5 hover:border-accent/50 transition-all duration-150 cursor-pointer hover-lift"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <Building className="h-5 w-5" />
                    </div>
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

                <div className="mt-4 pt-3 border-t border-border flex items-center text-xs">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Briefcase className="h-3 w-3" />
                    {company.job_count} active {company.job_count === 1 ? 'job' : 'jobs'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </MainLayout>
  );
};

export default Companies;
