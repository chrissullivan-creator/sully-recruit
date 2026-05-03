import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
import { supabase } from '@/integrations/supabase/client';
import { CANONICAL_PIPELINE, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';
import { cn } from '@/lib/utils';

interface FunnelStripProps {
  jobId: string;
  /** Currently selected stage filter — when null, no tile is highlighted. */
  activeStage: CanonicalStage | null;
  onStageClick: (stage: CanonicalStage | null) => void;
  /** When true, each tile registers as a @dnd-kit droppable so kanban cards
   *  can be dropped onto a tile to move stages. The DndContext that consumes
   *  these IDs lives in JobPipelineKanban and watches `funnel-tile:<key>`. */
  dropTargets?: boolean;
}

export function FunnelStrip({ jobId, activeStage, onStageClick, dropTargets = false }: FunnelStripProps) {
  const { data: rows = [] } = useQuery({
    queryKey: ['job_funnel', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_jobs')
        .select('pipeline_stage')
        .eq('job_id', jobId);
      if (error) throw error;
      return (data ?? []) as { pipeline_stage: string | null }[];
    },
  });

  const counts = useMemo(() => {
    const map = new Map<CanonicalStage, number>();
    for (const s of CANONICAL_PIPELINE) map.set(s.key, 0);
    for (const r of rows) {
      const c = stageToCanonical(r.pipeline_stage);
      if (c) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, [rows]);

  return (
    <div className="px-6 lg:px-8 py-3 bg-page-bg border-b border-card-border">
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
        {CANONICAL_PIPELINE.map((cfg) => (
          <FunnelTile
            key={cfg.key}
            cfg={cfg}
            count={counts.get(cfg.key) ?? 0}
            isActive={activeStage === cfg.key}
            onClick={() => onStageClick(activeStage === cfg.key ? null : cfg.key)}
            dropTarget={dropTargets}
          />
        ))}
      </div>
    </div>
  );
}

function FunnelTile({
  cfg, count, isActive, onClick, dropTarget,
}: {
  cfg: typeof CANONICAL_PIPELINE[number];
  count: number;
  isActive: boolean;
  onClick: () => void;
  dropTarget: boolean;
}) {
  const isOffer = cfg.key === 'offer';
  // Always call useDroppable so hooks are stable; ignore the ref when dropTarget=false.
  const { setNodeRef, isOver } = useDroppable({ id: `funnel-tile:${cfg.key}`, disabled: !dropTarget });

  return (
    <button
      ref={dropTarget ? setNodeRef : undefined}
      onClick={onClick}
      className={cn(
        'group relative rounded-lg border px-3 py-2.5 text-left transition-all hover:shadow-sm',
        isOffer
          ? 'bg-gold-bg border-gold/30 hover:border-gold/60'
          : 'bg-white border-card-border hover:border-emerald/40',
        isActive && (isOffer
          ? 'ring-2 ring-gold border-gold'
          : 'ring-2 ring-emerald border-emerald'),
        dropTarget && isOver && 'ring-2 ring-emerald border-emerald shadow-md bg-emerald-light/40',
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotColor)} />
        <span className={cn(
          'text-[10px] font-semibold uppercase tracking-wider truncate',
          isOffer ? 'text-gold-deep' : 'text-muted-foreground',
        )}>
          {cfg.shortLabel}
        </span>
      </div>
      <p className={cn(
        'text-xl font-bold tabular-nums font-display',
        isOffer ? 'text-gold-deep' : 'text-emerald-dark',
      )}>
        {count}
      </p>
    </button>
  );
}
