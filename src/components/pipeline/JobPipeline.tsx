import { mockJobs } from '@/data/mockData';
import { PipelineColumn, jobStageColors } from './PipelineColumn';
import { JobCard } from './JobCard';
import type { JobStage } from '@/types';

const stages: { key: JobStage; label: string }[] = [
  { key: 'warm', label: 'Warm' },
  { key: 'hot', label: 'Hot' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
  { key: 'on_hold', label: 'On Hold' },
];

export function JobPipeline() {
  const getJobsByStage = (stage: JobStage) => mockJobs.filter((job) => job.stage === stage);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const jobs = getJobsByStage(stage.key);
        return (
          <PipelineColumn
            key={stage.key}
            title={stage.label}
            count={jobs.length}
            items={jobs}
            stageColor={jobStageColors[stage.key]}
            renderItem={(job) => <JobCard job={job} />}
          />
        );
      })}
    </div>
  );
}
