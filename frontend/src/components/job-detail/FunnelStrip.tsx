import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { CANONICAL_PIPELINE, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';
import { cn } from '@/lib/utils';

interface FunnelStripProps {
  jobId: string;
  /** Currently selected stage filter — when null, no tile is highlighted. */
  activeStage: CanonicalStage | null;
  onStageClick: (stage: CanonicalStage | null) => void;
}

// 8-tile strip showing live counts per pipeline_stage for this job.
// Tiles are clickable filters AND drop targets (DnD wired in next pass).
export function FunnelStrip({ jobId, activeStage, onStageClick }: FunnelStripProps) {
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
        {CANONICAL_PIPELINE.map((cfg) => {
          const isActive = activeStage === cfg.key;
          const isOffer = cfg.key === 'offer';
          const count = counts.get(cfg.key) ?? 0;
          return (
            <button
              key={cfg.key}
              onClick={() => onStageClick(isActive ? null : cfg.key)}
              className={cn(
                'group relative rounded-lg border px-3 py-2.5 text-left transition-all hover:shadow-sm',
                isOffer
                  ? 'bg-gold-bg border-gold/30 hover:border-gold/60'
                  : 'bg-white border-card-border hover:border-emerald/40',
                isActive && (isOffer
                  ? 'ring-2 ring-gold border-gold'
                  : 'ring-2 ring-emerald border-emerald'),
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
        })}
      </div>
    </div>
  );
}
