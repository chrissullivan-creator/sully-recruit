import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDraggable, useDroppable,
  pointerWithin, type DragStartEvent, type DragEndEvent, type DragOverEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Briefcase, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  CANONICAL_PIPELINE, stageToCanonical, canonicalConfig,
  daysSince, type CanonicalStage,
} from '@/lib/pipeline';
import { moveStage } from '@/lib/mutations/move-stage';
import { formatComp } from '@/lib/queries/send-outs';
import { Button } from '@/components/ui/button';
import { AddCandidateModal } from '@/components/candidate/AddCandidateModal';

interface KanbanRow {
  id: string;                       // candidate_jobs id
  candidate_id: string;
  job_id: string;
  pipeline_stage: string | null;
  stage_updated_at: string | null;
  send_out_id: string | null;       // matched send_outs row (for moveStage write)
  candidate: {
    id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    current_company: string | null;
    avatar_url: string | null;
    target_total_comp: number | null;
    target_base_comp: number | null;
    type: string | null;
  } | null;
}

interface JobPipelineKanbanProps {
  jobId: string;
  /** When set, only render that column (used by the funnel-strip filter). */
  filterStage?: CanonicalStage | null;
}

export function JobPipelineKanban({ jobId, filterStage = null }: JobPipelineKanbanProps) {
  const queryClient = useQueryClient();
  const [activeRow, setActiveRow] = useState<KanbanRow | null>(null);
  const [overStage, setOverStage] = useState<CanonicalStage | null>(null);
  const [addModal, setAddModal] = useState<{ open: boolean; stage: CanonicalStage }>({ open: false, stage: 'pitch' });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['job_pipeline_kanban', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      // Pull candidate_jobs joined to people. Then in a second hop, find any
      // matching send_outs row (so moveStage can update both).
      const { data: cjData, error: cjErr } = await supabase
        .from('candidate_jobs')
        .select(`
          id, candidate_id, job_id, pipeline_stage, stage_updated_at,
          candidate:people!candidate_id(id, full_name, first_name, last_name, current_company, avatar_url, target_total_comp, target_base_comp, type)
        `)
        .eq('job_id', jobId);
      if (cjErr) throw cjErr;
      const cjRows = (cjData ?? []) as any[];
      if (cjRows.length === 0) return [] as KanbanRow[];

      const candidateIds = cjRows.map((r) => r.candidate_id).filter(Boolean);
      const { data: sendOutsForJob } = await supabase
        .from('send_outs')
        .select('id, candidate_id, candidate_job_id, job_id')
        .eq('job_id', jobId)
        .in('candidate_id', candidateIds);

      const soByCandidate = new Map<string, string>();
      const soByCandidateJob = new Map<string, string>();
      for (const so of (sendOutsForJob ?? [])) {
        if (so.candidate_job_id) soByCandidateJob.set(so.candidate_job_id, so.id);
        if (so.candidate_id) soByCandidate.set(so.candidate_id, so.id);
      }

      return cjRows.map((r) => ({
        ...r,
        send_out_id: soByCandidateJob.get(r.id) ?? soByCandidate.get(r.candidate_id) ?? null,
      })) as KanbanRow[];
    },
  });

  const rowsByStage = useMemo(() => {
    const map = new Map<CanonicalStage, KanbanRow[]>();
    for (const s of CANONICAL_PIPELINE) map.set(s.key, []);
    for (const r of rows) {
      const c = stageToCanonical(r.pipeline_stage);
      if (c) map.get(c)!.push(r);
    }
    return map;
  }, [rows]);

  const visibleStages = filterStage
    ? CANONICAL_PIPELINE.filter((s) => s.key === filterStage)
    : CANONICAL_PIPELINE;

  // Optimistic move via the shared moveStage helper.
  const commitMove = async (row: KanbanRow, target: CanonicalStage) => {
    queryClient.setQueryData<KanbanRow[]>(['job_pipeline_kanban', jobId], (prev = []) =>
      prev.map((r) => (r.id === row.id ? { ...r, pipeline_stage: target } : r)),
    );
    const res = row.send_out_id
      ? await moveStage({
          sendOutId: row.send_out_id,
          candidateJobId: row.id,
          fromStage: row.pipeline_stage,
          toStage: target,
          triggerSource: 'drag',
          entityId: row.candidate_id,
          entityType: 'candidate_job',
        })
      // No matching send_out — update candidate_jobs directly.
      : (async () => {
          const { error } = await supabase
            .from('candidate_jobs')
            .update({ pipeline_stage: target, stage_updated_at: new Date().toISOString() })
            .eq('id', row.id);
          if (error) return { ok: false, error: error.message };
          await supabase.from('stage_transitions').insert({
            entity_type: 'candidate_job', entity_id: row.id,
            from_stage: row.pipeline_stage, to_stage: target,
            trigger_source: 'drag',
          });
          return { ok: true };
        })();

    if (!res.ok) {
      queryClient.setQueryData<KanbanRow[]>(['job_pipeline_kanban', jobId], (prev = []) =>
        prev.map((r) => (r.id === row.id ? { ...r, pipeline_stage: row.pipeline_stage } : r)),
      );
      toast.error(res.error ?? 'Move failed');
      return;
    }
    toast.success(`Moved to ${canonicalConfig(target).label}`);
    queryClient.invalidateQueries({ queryKey: ['job_funnel', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job_quick_stats', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job_activity', jobId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard_metrics'] });
  };

  const onDragStart = (e: DragStartEvent) => {
    const row = rows.find((r) => r.id === e.active.id);
    setActiveRow(row ?? null);
  };
  const onDragOver = (e: DragOverEvent) => {
    const id = e.over?.id;
    if (typeof id === 'string' && id.startsWith('kanban-col:')) {
      setOverStage(id.slice('kanban-col:'.length) as CanonicalStage);
    } else if (typeof id === 'string' && id.startsWith('funnel-tile:')) {
      // Honour funnel-strip drop target IDs too.
      setOverStage(id.slice('funnel-tile:'.length) as CanonicalStage);
    } else {
      setOverStage(null);
    }
  };
  const onDragEnd = async (e: DragEndEvent) => {
    setActiveRow(null);
    setOverStage(null);
    const id = e.over?.id;
    if (typeof id !== 'string') return;
    const target = id.startsWith('kanban-col:')
      ? id.slice('kanban-col:'.length) as CanonicalStage
      : id.startsWith('funnel-tile:')
        ? id.slice('funnel-tile:'.length) as CanonicalStage
        : null;
    if (!target) return;
    const row = rows.find((r) => r.id === e.active.id);
    if (!row) return;
    if (stageToCanonical(row.pipeline_stage) === target) return;
    await commitMove(row, target);
  };

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading pipeline…</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
                onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
                onDragCancel={() => { setActiveRow(null); setOverStage(null); }}>
      <div className={cn(
        'grid gap-3',
        filterStage ? 'grid-cols-1' : 'grid-cols-2 lg:grid-cols-4 xl:grid-cols-4',
      )}>
        {visibleStages.map((cfg) => (
          <KanbanColumn
            key={cfg.key}
            cfg={cfg}
            rows={rowsByStage.get(cfg.key) ?? []}
            isOver={overStage === cfg.key}
            onAdd={() => setAddModal({ open: true, stage: cfg.key })}
          />
        ))}
      </div>

      <DragOverlay>
        {activeRow && (
          <div className="rounded-lg border border-emerald bg-white shadow-xl px-3 py-2 text-sm font-medium text-emerald-dark">
            {activeRow.candidate?.full_name ?? '—'}
          </div>
        )}
      </DragOverlay>

      <AddCandidateModal
        open={addModal.open}
        onOpenChange={(v) => setAddModal((prev) => ({ ...prev, open: v }))}
        jobId={jobId}
        stage={addModal.stage}
      />
    </DndContext>
  );
}

// ── Kanban column ───────────────────────────────────────────────────────
function KanbanColumn({
  cfg, rows, isOver, onAdd,
}: { cfg: typeof CANONICAL_PIPELINE[number]; rows: KanbanRow[]; isOver: boolean; onAdd: () => void }) {
  const { setNodeRef } = useDroppable({ id: `kanban-col:${cfg.key}` });
  const isOffer = cfg.key === 'offer';

  return (
    <div ref={setNodeRef} className={cn(
      'rounded-lg border bg-white flex flex-col min-h-[180px] transition-all',
      isOffer ? 'border-gold/30' : 'border-card-border',
      isOver && 'ring-2 ring-emerald border-emerald shadow-md bg-emerald-light/30',
    )}>
      {/* Column header */}
      <div className={cn(
        'flex items-center justify-between gap-2 px-3 py-2 border-b border-card-border',
        isOffer ? 'bg-gold-bg' : 'bg-page-bg/40',
      )}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', cfg.dotColor)} />
          <span className={cn(
            'text-[11px] font-semibold uppercase tracking-wider truncate font-display',
            isOffer ? 'text-gold-deep' : 'text-emerald-dark',
          )}>
            {cfg.label}
          </span>
          <span className={cn(
            'inline-flex items-center justify-center min-w-5 h-4 px-1 rounded-full text-[10px] font-semibold tabular-nums',
            isOffer ? 'bg-gold/20 text-gold-deep' : 'bg-emerald-light text-emerald-dark',
          )}>
            {rows.length}
          </span>
        </div>
        <button onClick={onAdd} title="Add to this stage"
                className="p-1 rounded text-muted-foreground hover:text-emerald hover:bg-emerald-light">
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2">
        {rows.length === 0 ? (
          <div className={cn(
            'flex items-center justify-center h-24 text-[11px] text-center px-2 rounded border border-dashed',
            isOver ? 'border-emerald text-emerald font-medium' : 'border-card-border text-muted-foreground/60',
          )}>
            {isOver ? 'Drop here →' : 'No candidates'}
          </div>
        ) : (
          rows.map((row) => <KanbanCard key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

// ── Kanban card ─────────────────────────────────────────────────────────
function KanbanCard({ row }: { row: KanbanRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: row.id,
    data: { type: 'kanban-card' },
  });
  const c = row.candidate;
  const name = c?.full_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || '—';
  const initials = ((c?.first_name?.[0] ?? '') + (c?.last_name?.[0] ?? '')).toUpperCase() || (name[0] ?? '?').toUpperCase();
  const comp = formatComp(c?.target_total_comp ?? c?.target_base_comp ?? null);
  const days = daysSince(row.stage_updated_at);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
      className="group rounded-lg border border-card-border bg-white p-2.5 hover:border-emerald/40 transition-colors"
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-emerald shrink-0"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        {c?.avatar_url ? (
          <img src={c.avatar_url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="h-7 w-7 shrink-0 rounded-full bg-emerald-light text-emerald flex items-center justify-center text-[10px] font-semibold">
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground truncate">{name}</p>
          {c?.current_company && (
            <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1 mt-0.5">
              <Briefcase className="h-2.5 w-2.5" /> {c.current_company}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 mt-1.5">
            <span className="text-[10px] text-gold-deep font-semibold tabular-nums">{comp}</span>
            <span className={cn(
              'text-[10px] tabular-nums px-1.5 rounded',
              days > 7 ? 'bg-amber-100 text-amber-800' : 'text-muted-foreground',
            )}>
              {days}d
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
