import { useMemo } from 'react';
import { TrendingUp, Filter, Award, Send } from 'lucide-react';
import { SectionCard } from '@/components/shared/SectionCard';
import { StatStrip } from '@/components/shared/StatStrip';
import { CANONICAL_PIPELINE, stageToCanonical, canonicalConfig, type CanonicalStage } from '@/lib/pipeline';
import type { SendOutRow } from '@/lib/queries/send-outs';
import { cn } from '@/lib/utils';

/**
 * Read-only analytics for the Send Outs page. Built ENTIRELY from the
 * already-loaded `rows` (the same filtered send-out rows that feed the
 * KPI tiles and stage tables) — no new fetching.
 */
export function SendOutsAnalytics({ rows, offerFee }: { rows: SendOutRow[]; offerFee?: number }) {
  // Funnel stages (exclude the terminal 'withdrawn' from the bar funnel —
  // it's an exit, not a forward step), counted from the loaded rows.
  const funnelStages: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted', 'interview', 'offer', 'placed'];

  const counts = useMemo(() => {
    const map = new Map<CanonicalStage, number>();
    for (const s of CANONICAL_PIPELINE) map.set(s.key, 0);
    for (const r of rows) {
      const c = stageToCanonical(r.stage);
      if (c) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, [rows]);

  const total = rows.length;
  const withdrawn = counts.get('withdrawn') ?? 0;
  const placed = counts.get('placed') ?? 0;
  const active = total - withdrawn - placed;

  const funnel = funnelStages.map((key) => ({
    key,
    label: canonicalConfig(key).label,
    dotColor: canonicalConfig(key).dotColor,
    value: counts.get(key) ?? 0,
  }));
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  // Conversion ratios between consecutive funnel stages, on loaded data.
  const ratios = funnel.slice(0, -1).map((f, i) => {
    const next = funnel[i + 1];
    const pct = f.value > 0 ? Math.round((next.value / f.value) * 100) : 0;
    return { from: f.label, to: next.label, pct };
  });

  return (
    <div className="space-y-6">
      <StatStrip
        items={[
          { label: 'Total Send Outs', value: total },
          { label: 'Active', value: active },
          { label: 'Placed', value: placed },
          { label: 'Est. Offer Fee', value: offerFee ? `$${Math.round(offerFee / 1000)}k` : '—', accent: true, hint: 'From offer-stage targets' },
        ]}
      />

      <SectionCard title="Pipeline Funnel" icon={<TrendingUp className="h-4 w-4" />}>
        <div className="space-y-3">
          {funnel.map((f) => {
            const pct = Math.round((f.value / funnelMax) * 100);
            const isOffer = f.key === 'offer';
            return (
              <div key={f.key} className="flex items-center gap-3">
                <div className="flex w-32 shrink-0 items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', f.dotColor)} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate">
                    {f.label}
                  </span>
                </div>
                <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-muted/40">
                  <div
                    className={cn(
                      'flex h-full items-center justify-end rounded-lg px-2 transition-all',
                      isOffer ? 'bg-accent/70' : 'bg-primary/70',
                    )}
                    style={{ width: `${Math.max(pct, f.value > 0 ? 8 : 0)}%` }}
                  >
                    {f.value > 0 && (
                      <span className="text-[11px] font-bold tabular-nums text-white">{f.value}</span>
                    )}
                  </div>
                </div>
                <span className="w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {total > 0 ? Math.round((f.value / total) * 100) : 0}%
                </span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Stage-to-Stage Conversion" icon={<Filter className="h-4 w-4" />}>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {ratios.map((r) => (
            <div key={`${r.from}-${r.to}`} className="rounded-xl border border-card-border bg-card p-4">
              <p className="text-2xl font-bold tabular-nums text-primary font-display">{r.pct}%</p>
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground leading-tight">
                {r.from} → {r.to}
              </p>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <SectionCard title="Outcomes" icon={<Award className="h-4 w-4" />}>
          <div className="grid grid-cols-3 gap-4">
            <Summary label="Placed" value={placed} accent />
            <Summary label="Withdrawn" value={withdrawn} />
            <Summary
              label="Win Rate"
              value={`${placed + withdrawn > 0 ? Math.round((placed / (placed + withdrawn)) * 100) : 0}%`}
            />
          </div>
        </SectionCard>

        <SectionCard title="Volume" icon={<Send className="h-4 w-4" />}>
          <div className="grid grid-cols-3 gap-4">
            <Summary label="In Flight" value={active} />
            <Summary label="Offer Stage" value={counts.get('offer') ?? 0} accent />
            <Summary label="Interviewing" value={counts.get('interview') ?? 0} />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function Summary({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div>
      <p className={cn('text-2xl font-bold tabular-nums font-display', accent ? 'text-accent' : 'text-foreground')}>
        {value}
      </p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
