import { useNavigate } from 'react-router-dom';
import { useJobs } from '@/hooks/useData';
import { PipelineColumn, jobStageColors } from './PipelineColumn';
import { Briefcase, MapPin } from 'lucide-react';

const stages = [
  { key: 'open', label: 'Open' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
  { key: 'on_hold', label: 'On Hold' },
];

export function JobPipeline() {
  const navigate = useNavigate();
  const { data: jobs = [] } = useJobs();

  const getJobsByStage = (stage: string) => jobs.filter((job) => job.status === stage);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const stageJobs = getJobsByStage(stage.key);
        return (
          <PipelineColumn
            key={stage.key}
            title={stage.label}
            count={stageJobs.length}
            items={stageJobs}
            stageColor={jobStageColors[stage.key as keyof typeof jobStageColors] ?? 'bg-muted text-muted-foreground'}
            renderItem={(job) => (
              <div onClick={() => navigate(`/jobs/${job.id}`)} className="group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:border-accent/50 hover:shadow-md">
                <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors line-clamp-1">
                  {job.title}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                  <Briefcase className="h-3 w-3" />
                  {job.company_name ?? (job.companies as any)?.name ?? '-'}
                </p>
                {job.location && (
                  <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {job.location}
                  </p>
                )}
              </div>
            )}
          />
        );
      })}
    </div>
  );
}
