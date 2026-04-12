import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useJobs } from '@/hooks/useData';
import { jobStageColors } from './PipelineColumn';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Briefcase, MapPin, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  useDroppable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import type { JobStage } from '@/types';

const stages = [
  { key: 'lead', label: 'Lead', headerClass: '' },
  { key: 'hot', label: 'Hot', headerClass: '' },
  { key: 'offer_made', label: 'Offer Made', headerClass: '' },
  { key: 'closed_won', label: 'Closed Won', headerClass: 'bg-[#1C3D2E] text-white border-[#1C3D2E]' },
  { key: 'closed_lost', label: 'Closed Lost', headerClass: 'bg-[#FEF2F2] text-[#DC2626] border-[#FEF2F2]' },
];

function JobCard({ job, isDragging }: { job: any; isDragging?: boolean }) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: job.id, data: { type: 'job', job } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isSortableDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:border-accent/50 hover:shadow-md',
        isDragging && 'shadow-lg border-accent/50 ring-2 ring-accent/20',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 min-w-0" onClick={() => navigate(`/jobs/${job.id}`)}>
          <div className="flex items-center gap-1.5">
            {job.job_code && (
              <span className="font-mono text-[10px] font-semibold text-accent bg-accent/10 px-1 py-0.5 rounded shrink-0">{job.job_code}</span>
            )}
            <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors line-clamp-1">
              {job.title}
            </h4>
          </div>
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
      </div>
    </div>
  );
}

function DroppableColumn({
  stage,
  jobs,
  isOver,
}: {
  stage: typeof stages[number];
  jobs: any[];
  isOver: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: stage.key, data: { type: 'column', stageKey: stage.key } });
  const stageColor = jobStageColors[stage.key as keyof typeof jobStageColors] ?? 'bg-muted text-muted-foreground';

  return (
    <div className="flex flex-col min-w-[280px] max-w-[300px]">
      <div className={cn("flex items-center justify-between px-3 py-2 rounded-t-lg bg-secondary border border-border border-b-0", stage.headerClass)}>
        <div className="flex items-center gap-2">
          <div className={cn('h-2 w-2 rounded-full', stageColor)} />
          <h3 className="text-sm font-medium text-foreground">{stage.label}</h3>
        </div>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
          {jobs.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 space-y-2 rounded-b-lg border border-border bg-card/30 p-2 min-h-[200px] transition-colors',
          isOver && 'bg-accent/5 border-accent/30',
        )}
      >
        <SortableContext items={jobs.map(j => j.id)} strategy={verticalListSortingStrategy}>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </SortableContext>
        {jobs.length === 0 && !isOver && (
          <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
            No items
          </div>
        )}
      </div>
    </div>
  );
}

export function JobPipeline() {
  const { data: jobs = [] } = useJobs();
  const queryClient = useQueryClient();
  const [activeJob, setActiveJob] = useState<any>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const getJobsByStage = (stage: string) => jobs.filter((job) => job.status === stage);

  const handleDragStart = (event: DragStartEvent) => {
    const job = jobs.find(j => j.id === event.active.id);
    setActiveJob(job ?? null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverColumn(null); return; }

    // Over a column directly
    if (stages.some(s => s.key === over.id)) {
      setOverColumn(over.id as string);
      return;
    }

    // Over a card — find which column it belongs to
    const overJob = jobs.find(j => j.id === over.id);
    if (overJob) {
      setOverColumn(overJob.status);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveJob(null);
    setOverColumn(null);

    if (!over) return;

    const jobId = active.id as string;
    const draggedJob = jobs.find(j => j.id === jobId);
    if (!draggedJob) return;

    // Determine target stage
    let targetStage: string | null = null;

    if (stages.some(s => s.key === over.id)) {
      targetStage = over.id as string;
    } else {
      const overJob = jobs.find(j => j.id === over.id);
      if (overJob) targetStage = overJob.status;
    }

    if (!targetStage || targetStage === draggedJob.status) return;

    // Optimistic update
    queryClient.setQueryData(['jobs'], (old: any[] | undefined) =>
      (old ?? []).map(j => j.id === jobId ? { ...j, status: targetStage } : j)
    );

    try {
      const { error } = await supabase
        .from('jobs')
        .update({ status: targetStage })
        .eq('id', jobId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err: any) {
      // Revert on failure
      queryClient.setQueryData(['jobs'], (old: any[] | undefined) =>
        (old ?? []).map(j => j.id === jobId ? { ...j, status: draggedJob.status } : j)
      );
      toast.error('Failed to move job');
    }
  };

  const handleDragCancel = () => {
    setActiveJob(null);
    setOverColumn(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => (
          <DroppableColumn
            key={stage.key}
            stage={stage}
            jobs={getJobsByStage(stage.key)}
            isOver={overColumn === stage.key}
          />
        ))}
      </div>
      <DragOverlay>
        {activeJob ? (
          <div className="w-[280px] rounded-lg border border-accent/50 bg-card p-3 shadow-xl ring-2 ring-accent/20">
            <h4 className="text-sm font-medium text-foreground line-clamp-1">{activeJob.title}</h4>
            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
              <Briefcase className="h-3 w-3" />
              {activeJob.company_name ?? (activeJob.companies as any)?.name ?? '-'}
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
