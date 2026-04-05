import { Briefcase, MapPin, Users, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Job, JobStage } from '@/types';

interface JobCardProps {
  job: Job;
  onClick?: () => void;
}

const priorityColors = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-warning/10 text-warning border border-warning/20',
  high: 'bg-destructive/10 text-destructive border border-destructive/20',
};

export function JobCard({ job, onClick }: JobCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150',
        'hover:border-accent/50 hover:shadow-md'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors line-clamp-1">
          {job.title}
        </h4>
        <span className={cn('stage-badge shrink-0', priorityColors[job.priority])}>
          {job.priority}
        </span>
      </div>
      
      <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
        <Briefcase className="h-3 w-3" />
        {job.company}
      </p>
      
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          {job.location}
        </span>
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {job.candidateCount}
        </span>
      </div>
      
      {job.salary && (
        <p className="mt-2 text-xs font-medium text-accent flex items-center gap-1">
          <DollarSign className="h-3 w-3" />
          {job.salary}
        </p>
      )}
    </div>
  );
}
