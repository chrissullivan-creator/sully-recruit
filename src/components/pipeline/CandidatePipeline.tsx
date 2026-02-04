import { mockCandidates } from '@/data/mockData';
import { PipelineColumn, candidateStageColors } from './PipelineColumn';
import { CandidateCard } from './CandidateCard';
import type { CandidateStage } from '@/types';

const stages: { key: CandidateStage; label: string }[] = [
  { key: 'pitch', label: 'Pitch' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'first_round', label: '1st Round' },
  { key: 'second_round', label: '2nd Round' },
  { key: 'offer', label: 'Offer' },
];

export function CandidatePipeline() {
  const getCandidatesByStage = (stage: CandidateStage) => 
    mockCandidates.filter((candidate) => candidate.stage === stage);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const candidates = getCandidatesByStage(stage.key);
        return (
          <PipelineColumn
            key={stage.key}
            title={stage.label}
            count={candidates.length}
            items={candidates}
            stageColor={candidateStageColors[stage.key]}
            renderItem={(candidate) => <CandidateCard candidate={candidate} />}
          />
        );
      })}
    </div>
  );
}
