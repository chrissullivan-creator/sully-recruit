import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { CandidatePipeline } from '@/components/pipeline/CandidatePipeline';
import { mockCandidates } from '@/data/mockData';
import { Plus, LayoutGrid, List, Search, Building } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CandidateStage } from '@/types';

const stageLabels: Record<CandidateStage, string> = {
  back_of_resume: 'Back of Resume',
  pitch: 'Pitch',
  send_out: 'Send Out',
  submitted: 'Submitted',
  interview: 'Interview',
  first_round: '1st Round',
  second_round: '2nd Round',
  third_plus_round: '3+ Rounds',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined',
  counter_offer: 'Counter Offer',
  disqualified: 'Disqualified',
};

const stageColors: Record<CandidateStage, string> = {
  back_of_resume: 'bg-muted text-muted-foreground',
  pitch: 'stage-warm',
  send_out: 'stage-warm',
  submitted: 'stage-interview',
  interview: 'stage-interview',
  first_round: 'stage-interview',
  second_round: 'bg-info/10 text-info border-info/20',
  third_plus_round: 'bg-info/10 text-info border-info/20',
  offer: 'stage-offer',
  accepted: 'bg-success/10 text-success border-success/20',
  declined: 'bg-destructive/10 text-destructive border-destructive/20',
  counter_offer: 'bg-warning/10 text-warning border-warning/20',
  disqualified: 'bg-muted text-muted-foreground',
};

const Candidates = () => {
  const [view, setView] = useState<'pipeline' | 'list'>('pipeline');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCandidates = mockCandidates.filter((candidate) =>
    `${candidate.firstName} ${candidate.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
    candidate.currentCompany.toLowerCase().includes(searchQuery.toLowerCase()) ||
    candidate.currentTitle.toLowerCase().includes(searchQuery.toLowerCase())
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
        {/* Search */}
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

        {view === 'pipeline' ? (
          <CandidatePipeline />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Stage</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Source</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Skills</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCandidates.map((candidate) => (
                  <tr key={candidate.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                          {candidate.firstName[0]}{candidate.lastName[0]}
                        </div>
                        <div>
                          <span className="text-sm font-medium text-foreground">
                            {candidate.firstName} {candidate.lastName}
                          </span>
                          <p className="text-xs text-muted-foreground">{candidate.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{candidate.currentTitle}</td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <Building className="h-3 w-3" />
                        {candidate.currentCompany}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('stage-badge', stageColors[candidate.stage])}>
                        {stageLabels[candidate.stage]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{candidate.source || '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {candidate.skills.slice(0, 2).map((skill) => (
                          <span key={skill} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </td>
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
