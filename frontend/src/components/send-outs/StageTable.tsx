import { ChevronDown, ChevronRight, Plus, Star, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CandidateRow } from './CandidateRow';
import { type SendOutRow } from '@/lib/queries/send-outs';
import { type CanonicalStageConfig } from '@/lib/pipeline';

interface StageTableProps {
  config: CanonicalStageConfig;
  rows: SendOutRow[];
  isOpen: boolean;
  onToggle: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onAdvance: (row: SendOutRow) => void;
  onOpen: (row: SendOutRow) => void;
  onAdd?: () => void;
}

export function StageTable({
  config, rows, isOpen, onToggle, selectedIds, onToggleSelect, onAdvance, onOpen, onAdd,
}: StageTableProps) {
  const isOffer = config.key === 'offer';

  return (
    <div className={cn(
      'rounded-xl border bg-white overflow-hidden',
      isOffer ? 'border-gold/30 shadow-sm' : 'border-card-border',
    )}>
      {/* Header row */}
      <button
        onClick={onToggle}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-3 transition-colors text-left',
          isOpen ? 'border-b border-card-border' : '',
          isOffer ? 'bg-gold-bg hover:bg-gold-bg/80' : 'hover:bg-emerald-light/40',
        )}
      >
        {isOpen
          ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className={cn('h-2 w-2 rounded-full shrink-0', config.dotColor)} />
        <h3 className={cn(
          'text-sm font-semibold font-display',
          isOffer ? 'text-gold-deep' : 'text-emerald-dark',
        )}>{config.label}</h3>
        <span className={cn(
          'inline-flex items-center justify-center min-w-6 h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums',
          isOffer ? 'bg-gold/20 text-gold-deep' : 'bg-emerald-light text-emerald-dark',
        )}>
          {rows.length}
        </span>
        {isOffer && (
          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-gold/15 text-gold-deep text-[10px] font-semibold uppercase tracking-wider">
            <Star className="h-2.5 w-2.5 fill-current" /> Priority
          </span>
        )}

        <div className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/40"
            title="Bulk actions"
            onClick={(e) => { e.stopPropagation(); /* TODO bulk */ }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {onAdd && (
            <button
              onClick={(e) => { e.stopPropagation(); onAdd(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-emerald hover:bg-emerald-light"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          )}
        </div>
      </button>

      {/* Rows */}
      {isOpen && (
        rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No candidates in this stage yet — drop someone in.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-card-border bg-page-bg/40">
                  <th className="w-8" />
                  <th className="w-8" />
                  <th className="px-3 py-2">Candidate</th>
                  <th className="px-3 py-2">Current Role</th>
                  <th className="px-3 py-2">Target Comp</th>
                  <th className="px-3 py-2">Last Touch</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2">Next Step</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <CandidateRow
                    key={row.id}
                    row={row}
                    stage={config.key}
                    index={i}
                    selected={selectedIds.has(row.id)}
                    onToggleSelect={onToggleSelect}
                    onAdvance={onAdvance}
                    onOpen={onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
