import { cn } from '@/lib/utils';
import { Send, FileCheck, Calendar, Award } from 'lucide-react';
import type { SendOutRow } from '@/lib/queries/send-outs';
import { stageToCanonical } from '@/lib/pipeline';

interface KpiTilesProps {
  rows: SendOutRow[];
  /** Called with the canonical stage key (or 'all' for Active) when a tile is clicked. */
  onTileClick: (target: 'all' | 'submitted' | 'interviewing' | 'offer') => void;
  /** Estimated fee from offer-stage rows — passed in from the page once it can compute it. */
  offerFee?: number;
}

export function KpiTiles({ rows, onTileClick, offerFee }: KpiTilesProps) {
  // Counts by canonical stage. "Active" excludes placed + withdrawn.
  let active = 0, submitted = 0, interviewing = 0, offer = 0;
  for (const r of rows) {
    const c = stageToCanonical(r.stage);
    if (!c) continue;
    if (c !== 'placed' && c !== 'withdrawn') active++;
    if (c === 'submitted') submitted++;
    if (c === 'interview_round_1' || c === 'interview_round_2_plus') interviewing++;
    if (c === 'offer') offer++;
  }

  const tiles = [
    { key: 'all',          label: 'Active',       value: active,       icon: Send,      gold: false, onClick: () => onTileClick('all') },
    { key: 'submitted',    label: 'Submitted',    value: submitted,    icon: FileCheck, gold: false, onClick: () => onTileClick('submitted') },
    { key: 'interviewing', label: 'Interviewing', value: interviewing, icon: Calendar,  gold: false, onClick: () => onTileClick('interviewing') },
    { key: 'offer',        label: 'Offer Stage',  value: offer,        icon: Award,     gold: true,  onClick: () => onTileClick('offer'), sub: offerFee ? `~$${Math.round(offerFee / 1000)}k est. fee` : undefined },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={t.onClick}
            className={cn(
              'group text-left rounded-xl border p-5 transition-all hover:shadow-md',
              t.gold
                ? 'bg-gold-bg border-gold/30 hover:border-gold/60'
                : 'bg-white border-card-border hover:border-emerald/40',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn(
                  'text-xs font-semibold uppercase tracking-wider',
                  t.gold ? 'text-gold-deep' : 'text-muted-foreground',
                )}>{t.label}</p>
                <p className={cn(
                  'text-3xl font-bold tabular-nums mt-2 font-display',
                  t.gold ? 'text-gold-deep' : 'text-emerald-dark',
                )}>{t.value}</p>
                {t.sub && (
                  <p className="text-xs text-gold-deep/80 font-medium mt-1">{t.sub}</p>
                )}
              </div>
              <div className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg shrink-0',
                t.gold ? 'bg-gold/15 text-gold-deep' : 'bg-emerald-light text-emerald',
              )}>
                <Icon className="h-5 w-5" />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
