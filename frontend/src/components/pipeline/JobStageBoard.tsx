import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

// A configurable job kanban. Two modes:
//  - Draggable (onMove set): cards can be dragged between columns; dropping
//    calls onMove(jobId, columnKey). Used by the Leads board to advance
//    jobs.lead_stage.
//  - Read-only (onMove omitted): static columns, cards just navigate. Used by
//    the Hot Jobs board, whose column is DERIVED from each job's furthest
//    candidate (you change it by moving candidates in the pipeline, not the job).
export interface BoardColumn {
  key: string;
  label: string;
  /** Dot color class for the column header. */
  dotClass?: string;
  /** Optional header background/border override (e.g. closed columns). */
  headerClass?: string;
}

interface JobStageBoardProps {
  jobs: any[];
  columns: BoardColumn[];
  /** Which column key a job belongs in. */
  getColumnKey: (job: any) => string;
  /** When provided, cards are draggable and a drop calls this. Omit → read-only. */
  onMove?: (jobId: string, columnKey: string, job: any) => void;
  /** Optional extra content rendered at the bottom of each card. */
  renderCardMeta?: (job: any) => React.ReactNode;
}

function CardBody({ job, renderCardMeta }: { job: any; renderCardMeta?: (j: any) => React.ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        {job.job_code && (
          <span className="font-mono text-[10px] font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded-full shrink-0">{job.job_code}</span>
        )}
        <h4 className="text-sm font-semibold text-foreground group-hover:text-accent transition-colors line-clamp-1">
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
      {renderCardMeta?.(job)}
    </>
  );
}

function SortableCard({ job, renderCardMeta }: { job: any; renderCardMeta?: (j: any) => React.ReactNode }) {
  const navigate = useNavigate();
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: job.id, data: { type: 'job', job } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group cursor-pointer rounded-2xl border border-card-border bg-card p-3 transition-all duration-200 hover:border-accent/50 hover:shadow-md hover:-translate-y-0.5"
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-accent shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 min-w-0" onClick={() => navigate(`/jobs/${job.id}`)}>
          <CardBody job={job} renderCardMeta={renderCardMeta} />
        </div>
      </div>
    </div>
  );
}

function StaticCard({ job, renderCardMeta }: { job: any; renderCardMeta?: (j: any) => React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div
      onClick={() => navigate(`/jobs/${job.id}`)}
      className="group cursor-pointer rounded-2xl border border-card-border bg-card p-3 transition-all duration-200 hover:border-accent/50 hover:shadow-md hover:-translate-y-0.5"
    >
      <CardBody job={job} renderCardMeta={renderCardMeta} />
    </div>
  );
}

function ColumnHeader({ column, count }: { column: BoardColumn; count: number }) {
  return (
    <div className={cn('flex items-center justify-between px-3 py-2.5 rounded-t-2xl bg-muted/40 border border-card-border border-b-0', column.headerClass)}>
      <div className="flex items-center gap-2 min-w-0">
        <div className={cn('h-2 w-2 rounded-full shrink-0', column.dotClass ?? 'bg-muted-foreground')} />
        <h3 className="text-[13px] font-semibold text-foreground truncate">{column.label}</h3>
      </div>
      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-card px-1.5 text-xs font-semibold text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  );
}

function DroppableColumn({
  column, jobs, isOver, renderCardMeta,
}: {
  column: BoardColumn;
  jobs: any[];
  isOver: boolean;
  renderCardMeta?: (j: any) => React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: column.key, data: { type: 'column', columnKey: column.key } });
  return (
    <div className="flex flex-col min-w-[280px] max-w-[300px]">
      <ColumnHeader column={column} count={jobs.length} />
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 space-y-2 rounded-b-2xl border border-card-border bg-muted/20 p-2 min-h-[200px] transition-colors',
          isOver && 'bg-accent/5 border-accent/40',
        )}
      >
        <SortableContext items={jobs.map((j) => j.id)} strategy={verticalListSortingStrategy}>
          {jobs.map((job) => (
            <SortableCard key={job.id} job={job} renderCardMeta={renderCardMeta} />
          ))}
        </SortableContext>
        {jobs.length === 0 && !isOver && (
          <div className="flex items-center justify-center h-20 text-sm text-muted-foreground/70">No jobs</div>
        )}
      </div>
    </div>
  );
}

function StaticColumn({
  column, jobs, renderCardMeta,
}: {
  column: BoardColumn;
  jobs: any[];
  renderCardMeta?: (j: any) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-w-[280px] max-w-[300px]">
      <ColumnHeader column={column} count={jobs.length} />
      <div className="flex-1 space-y-2 rounded-b-2xl border border-card-border bg-muted/20 p-2 min-h-[200px]">
        {jobs.map((job) => (
          <StaticCard key={job.id} job={job} renderCardMeta={renderCardMeta} />
        ))}
        {jobs.length === 0 && (
          <div className="flex items-center justify-center h-20 text-sm text-muted-foreground/70">No jobs</div>
        )}
      </div>
    </div>
  );
}

export function JobStageBoard({ jobs, columns, getColumnKey, onMove, renderCardMeta }: JobStageBoardProps) {
  const [activeJob, setActiveJob] = useState<any>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byColumn: Record<string, any[]> = {};
  for (const col of columns) byColumn[col.key] = [];
  for (const job of jobs) {
    const key = getColumnKey(job);
    (byColumn[key] ??= []).push(job);
  }

  // Read-only board (Hot Jobs): no DnD, columns derived from candidates.
  if (!onMove) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <StaticColumn key={column.key} column={column} jobs={byColumn[column.key] ?? []} renderCardMeta={renderCardMeta} />
        ))}
      </div>
    );
  }

  const columnKeys = new Set(columns.map((c) => c.key));

  const handleDragStart = (event: DragStartEvent) => {
    setActiveJob(jobs.find((j) => j.id === event.active.id) ?? null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverColumn(null); return; }
    if (columnKeys.has(over.id as string)) { setOverColumn(over.id as string); return; }
    const overJob = jobs.find((j) => j.id === over.id);
    if (overJob) setOverColumn(getColumnKey(overJob));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveJob(null);
    setOverColumn(null);
    if (!over) return;

    const jobId = active.id as string;
    const dragged = jobs.find((j) => j.id === jobId);
    if (!dragged) return;

    let target: string | null = null;
    if (columnKeys.has(over.id as string)) target = over.id as string;
    else {
      const overJob = jobs.find((j) => j.id === over.id);
      if (overJob) target = getColumnKey(overJob);
    }
    if (!target || target === getColumnKey(dragged)) return;
    onMove(jobId, target, dragged);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { setActiveJob(null); setOverColumn(null); }}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <DroppableColumn
            key={column.key}
            column={column}
            jobs={byColumn[column.key] ?? []}
            isOver={overColumn === column.key}
            renderCardMeta={renderCardMeta}
          />
        ))}
      </div>
      <DragOverlay>
        {activeJob ? (
          <div className="w-[280px] rounded-2xl border border-accent/50 bg-card p-3 shadow-xl ring-2 ring-accent/20">
            <h4 className="text-sm font-semibold text-foreground line-clamp-1">{activeJob.title}</h4>
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
