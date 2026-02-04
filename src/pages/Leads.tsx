import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { mockLeads } from '@/data/mockData';
import { Plus, Search, Filter, Target, Users, Building, Briefcase } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LeadType, LeadStatus } from '@/types';

const leadTypeIcons: Record<LeadType, React.ReactNode> = {
  opportunity: <Briefcase className="h-4 w-4" />,
  lead_candidate: <Users className="h-4 w-4" />,
  contact: <Users className="h-4 w-4" />,
  target_company: <Building className="h-4 w-4" />,
};

const leadTypeLabels: Record<LeadType, string> = {
  opportunity: 'Opportunity',
  lead_candidate: 'Candidate',
  contact: 'Contact',
  target_company: 'Company',
};

const statusColors: Record<LeadStatus, string> = {
  new: 'bg-info/10 text-info border-info/20',
  reached_out: 'bg-warning/10 text-warning border-warning/20',
  qualified: 'bg-success/10 text-success border-success/20',
  converted: 'bg-accent/10 text-accent border-accent/20',
  disqualified: 'bg-destructive/10 text-destructive border-destructive/20',
  no_answer: 'bg-muted text-muted-foreground border-border',
};

const Leads = () => {
  const [filter, setFilter] = useState<LeadType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredLeads = mockLeads.filter((lead) => {
    const matchesFilter = filter === 'all' || lead.type === filter;
    const matchesSearch = lead.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.company?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <MainLayout>
      <PageHeader 
        title="Leads" 
        description="Manage your pipeline of opportunities, candidates, contacts, and target companies."
        actions={
          <Button variant="gold">
            <Plus className="h-4 w-4" />
            Add Lead
          </Button>
        }
      />
      
      <div className="p-8">
        {/* Filters */}
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
            <Button
              variant={filter === 'all' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter('all')}
            >
              All
            </Button>
            <Button
              variant={filter === 'opportunity' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter('opportunity')}
            >
              <Briefcase className="h-4 w-4 mr-1" />
              Opportunities
            </Button>
            <Button
              variant={filter === 'lead_candidate' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter('lead_candidate')}
            >
              <Users className="h-4 w-4 mr-1" />
              Candidates
            </Button>
            <Button
              variant={filter === 'contact' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter('contact')}
            >
              <Users className="h-4 w-4 mr-1" />
              Contacts
            </Button>
            <Button
              variant={filter === 'target_company' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter('target_company')}
            >
              <Building className="h-4 w-4 mr-1" />
              Companies
            </Button>
          </div>
        </div>

        {/* Leads Table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-secondary">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Type</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Source</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredLeads.map((lead) => (
                <tr key={lead.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {leadTypeIcons[lead.type]}
                      <span className="text-xs">{leadTypeLabels[lead.type]}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-foreground">{lead.name}</span>
                    {lead.email && (
                      <p className="text-xs text-muted-foreground">{lead.email}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{lead.company || '-'}</td>
                  <td className="px-4 py-3">
                    <span className={cn('stage-badge border', statusColors[lead.status])}>
                      {lead.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{lead.source || '-'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {lead.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MainLayout>
  );
};

export default Leads;
