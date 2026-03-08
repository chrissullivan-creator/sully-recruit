import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { CandidatePipeline } from '@/components/pipeline/CandidatePipeline';
import { useCandidates } from '@/hooks/useSupabaseData';
import { Plus, LayoutGrid, List, Search, Building } from 'lucide-react';
import { cn } from '@/lib/utils';

const Candidates = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');
  const { data: candidates = [], isLoading } = useCandidates();

  const filteredCandidates = candidates.filter((c) =>
    (c.full_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.current_company ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.current_title ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <MainLayout>
      <PageHeader 
        title="Candidates" 
        description="Track candidates through interview stages across all jobs."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setView('pipeline')}
                className={cn(
                  'p-2 transition-colors',
                  view === 'pipeline' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView('list')}
                className={cn(
                  'p-2 transition-colors',
                  view === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <Button variant="gold">
              <Plus className="h-4 w-4" />
              Add Candidate
            </Button>
          </div>
        }
      />
      
      <div className="p-8">
        <div className="relative max-w-md mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search candidates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading candidates...</p>
        ) : view === 'pipeline' ? (
          <CandidatePipeline />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCandidates.map((candidate) => (
                  <tr key={candidate.id} className="hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => navigate(`/candidates/${candidate.id}`)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                          {(candidate.first_name?.[0] ?? '')}{(candidate.last_name?.[0] ?? '')}
                        </div>
                        <span className="text-sm font-medium text-foreground">
                          {candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{candidate.current_title ?? '-'}</td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Building className="h-3 w-3" />
                        {candidate.current_company ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="stage-badge bg-info/10 text-info border border-info/20">
                        {candidate.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{candidate.email ?? '-'}</td>
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

export default Candidates;
