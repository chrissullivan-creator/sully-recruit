import { cn } from '@/lib/utils';
import type { PipelineStats } from '@/lib/send-out-insights';
import type { CanonicalStage } from '@/lib/pipeline';

interface Tile {
  label: string;
  value: string | number;
  /** Sublabel; `tone` controls its color. */
  hint?: string;
  tone?: 'muted' | 'warn' | 'good';
  accent?: boolean;        // gold value (offer/rate)
  stage?: CanonicalStage;  // click filters/scrolls to this stage
}

/**
 * The Send Outs KPI strip: Active Pipeline · Pitch · Send Out · Submission ·
 * Interview · Offer · Placed · Placement Rate. Follow-up counts (real, from
 * `computePipelineStats`) surface as amber sublabels so stalled stages stand out.
 */
export function PipelineKpiStrip({
  stats, onStageClick,
}: { stats: PipelineStats; onStageClick?: (s: CanonicalStage) => void }) {
  const fu = (s: CanonicalStage) => stats.followUpByStage[s] ?? 0;

  const tiles: Tile[] = [
    {
      label: 'Active Pipeline', value: stats.active,
      hint: stats.followUpTotal > 0 ? `${stats.followUpTotal} need follow-up` : 'all on track',
      tone: stats.followUpTotal > 0 ? 'warn' : 'good',
    },
    { label: 'Pitch', value: stats.byStage.pitch ?? 0, stage: 'pitch',
      hint: fu('pitch') > 0 ? `${fu('pitch')} need follow-up` : undefined, tone: 'warn' },
    { label: 'Send Out', value: stats.byStage.ready_to_send ?? 0, stage: 'ready_to_send',
      hint: fu('ready_to_send') > 0 ? `${fu('ready_to_send')} need follow-up` : undefined, tone: 'warn' },
    { label: 'Submission', value: stats.byStage.submitted ?? 0, stage: 'submitted',
      hint: fu('submitted') > 0 ? `${fu('submitted')} need follow-up` : undefined, tone: 'warn' },
    { label: 'Interview', value: stats.byStage.interview ?? 0, stage: 'interview',
      hint: stats.interviewsThisWeek > 0 ? `${stats.interviewsThisWeek} this week` : undefined, tone: 'muted' },
    { label: 'Offer', value: stats.byStage.offer ?? 0, stage: 'offer', accent: (stats.byStage.offer ?? 0) > 0,
      hint: (stats.byStage.offer ?? 0) === 0 ? 'No active offers' : undefined, tone: 'muted' },
    { label: 'Placed', value: stats.byStage.placed ?? 0, stage: 'placed',
      hint: stats.placedThisMonth > 0 ? `${stats.placedThisMonth} this month` : undefined, tone: 'good' },
    { label: 'Placement Rate', value: `${stats.placementRate}%`, accent: true, hint: 'placed / total', tone: 'muted' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 divide-y divide-x divide-card-border rounded-2xl border border-card-border bg-card shadow-sm overflow-hidden">
      {tiles.map((t) => {
        const interactive = !!t.stage && !!onStageClick;
        return (
          <div
            key={t.label}
            onClick={interactive ? () => onStageClick!(t.stage!) : undefined}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStageClick!(t.stage!); } } : undefined}
            className={cn('px-4 py-3.5 min-w-0', interactive && 'cursor-pointer transition-colors hover:bg-muted/40')}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate">{t.label}</p>
            <p className={cn('mt-1 text-2xl font-bold tabular-nums leading-none', t.accent ? 'text-accent' : 'text-foreground')}>
              {t.value}
            </p>
            {t.hint && (
              <p className={cn(
                'mt-1.5 text-[11px] font-medium truncate',
                t.tone === 'warn' ? 'text-stage-hot' : t.tone === 'good' ? 'text-success' : 'text-muted-foreground',
              )}>
                {t.hint}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
