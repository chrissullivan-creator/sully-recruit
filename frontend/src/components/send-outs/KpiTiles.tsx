import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { Send, FileCheck, Calendar, Award } from 'lucide-react';
import type { SendOutRow } from '@/lib/queries/send-outs';
import { stageToCanonical, type CanonicalStage } from '@/lib/pipeline';

interface KpiTilesProps {
  rows: SendOutRow[];
  /** Called with the canonical stage key (or 'all' for Active) when a tile is clicked. */
  onTileClick: (target: 'all' | 'submitted' | 'interviewing' | 'offer') => void;
  /** Estimated fee from offer-stage rows — passed in from the page once it can compute it. */
  offerFee?: number;
}

interface TileSpec {
  key: 'all' | 'submitted' | 'interviewing' | 'offer';
  label: string;
  value: number;
  icon: typeof Send;
  gold: boolean;
  /** Single canonical stage this tile drops onto. Active tile (=all) has no drop target. */
  dropStage: CanonicalStage | null;
  sub?: string;
}

export function KpiTiles({ rows, onTileClick, offerFee }: KpiTilesProps) {
  // Counts by canonical stage. "Active" excludes placed + withdrawn.
  let active = 0, submitted = 0, interviewing = 0, offer = 0;
  for (const r of rows) {
    const c = stageToCanonical(r.stage);
    if (!c) continue;
    if (c !== 'placed' && c !== 'withdrawn') active++;
    if (c === 'submitted') submitted++;
    if (c === 'interview') interviewing++;
    if (c === 'offer') offer++;
  }

  const tiles: TileSpec[] = [
    { key: 'all',          label: 'Active',       value: active,       icon: Send,      gold: false, dropStage: null },
    { key: 'submitted',    label: 'Submission',   value: submitted,    icon: FileCheck, gold: false, dropStage: 'submitted' },
    { key: 'interviewing', label: 'Interviewing', value: interviewing, icon: Calendar,  gold: false, dropStage: 'interview' },
    { key: 'offer',        label: 'Offer Stage',  value: offer,        icon: Award,     gold: true,  dropStage: 'offer', sub: offerFee ? `~$${Math.round(offerFee / 1000)}k est. fee` : undefined },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((t) => (
        <KpiTile
          key={t.key}
          spec={t}
          onClick={() => onTileClick(t.key)}
        />
      ))}
    </div>
  );
}

function KpiTile({ spec, onClick }: { spec: TileSpec; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: spec.dropStage ? `kpi-tile:${spec.dropStage}` : `kpi-tile:noop:${spec.key}`,
    disabled: !spec.dropStage,
  });
  const Icon = spec.icon;
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      className={cn(
        'group text-left rounded-xl border p-5 transition-all hover:shadow-md',
        spec.gold
          ? 'bg-gold-bg border-gold/30 hover:border-gold/60'
          : 'bg-white border-card-border hover:border-emerald/40',
        isOver && spec.dropStage && 'ring-2 ring-emerald shadow-md',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn(
            'text-xs font-semibold uppercase tracking-wider',
            spec.gold ? 'text-gold-deep' : 'text-muted-foreground',
          )}>{spec.label}</p>
          <p className={cn(
            'text-3xl font-bold tabular-nums mt-2 font-display',
            spec.gold ? 'text-gold-deep' : 'text-emerald-dark',
          )}>{spec.value}</p>
          {spec.sub && (
            <p className="text-xs text-gold-deep/80 font-medium mt-1">{spec.sub}</p>
          )}
          {isOver && spec.dropStage && (
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald mt-1">
              Drop to move
            </p>
          )}
        </div>
        <div className={cn(
          'flex h-10 w-10 items-center justify-center rounded-lg shrink-0',
          spec.gold ? 'bg-gold/15 text-gold-deep' : 'bg-emerald-light text-emerald',
        )}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </button>
  );
}
