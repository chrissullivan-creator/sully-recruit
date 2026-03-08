import { useNavigate } from 'react-router-dom';
import { useCandidates } from '@/hooks/useSupabaseData';
import { PipelineColumn, candidateStageColors } from './PipelineColumn';
import { Building } from 'lucide-react';

const stages = [
  { key: 'active', label: 'Active' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'placed', label: 'Placed' },
];

export function CandidatePipeline() {
  const navigate = useNavigate();
  const { data: candidates = [] } = useCandidates();

  const getCandidatesByStage = (stage: string) => 
    candidates.filter((c) => c.status === stage);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const stageCandidates = getCandidatesByStage(stage.key);
        return (
          <PipelineColumn
            key={stage.key}
            title={stage.label}
            count={stageCandidates.length}
            items={stageCandidates}
            stageColor={candidateStageColors[stage.key as keyof typeof candidateStageColors] ?? 'bg-muted text-muted-foreground'}
            renderItem={(candidate) => (
              <div
                onClick={() => navigate(`/candidates/${candidate.id}`)}
                className="group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:border-accent/50 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                    {(candidate.first_name?.[0] ?? '')}{(candidate.last_name?.[0] ?? '')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors truncate">
                      {candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`}
                    </h4>
                    <p className="text-xs text-muted-foreground truncate">{candidate.current_title ?? '-'}</p>
                    {candidate.current_company && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Building className="h-3 w-3" />
                        {candidate.current_company}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          />
        );
      })}
    </div>
  );
}
