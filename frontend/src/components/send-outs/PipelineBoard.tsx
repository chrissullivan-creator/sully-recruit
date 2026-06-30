import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Plus, ChevronRight, Clock, AlertCircle, Building2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/components/shared/PersonAvatar';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { type SendOutRow, formatComp, formatCompRange } from '@/lib/queries/send-outs';
import { CANONICAL_PIPELINE, canonicalConfig, nextStage, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';
import { daysInStage, needsFollowUp } from '@/lib/send-out-insights';
import { InterviewStageStrip } from '@/components/interviews/InterviewStageStrip';

// Columns shown on the board (Rejected/withdrawn is excluded — it lives in the
// All Send Outs tab). Subtitles mirror the product mockup.
const BOARD_STAGES: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted', 'interview', 'offer', 'placed'];
const SUBTITLE: Record<string, string> = {
  pitch: 'Candidate needs to be pitched',
  ready_to_send: 'Ready to send to client',
  submitted: 'Submitted to client',
  interview: 'In interview process',
  offer: 'Offer extended',
  placed: 'Successfully placed',
};
const DOT: Record<string, string> = {
  pitch: 'bg-stage-warm', ready_to_send: 'bg-yellow-600', submitted: 'bg-purple-600',
  interview: 'bg-info', offer: 'bg-gold', placed: 'bg-emerald',
};
// Label for the job block on the card — changes with the row's stage.
const JOB_LABEL: Record<string, string> = {
  pitch: 'Submitting for',
  ready_to_send: 'Submitting for',
  submitted: 'Submitted to',
  interview: 'Interviewing for',
  offer: 'Offered for',
  placed: 'Placed at',
};

interface BoardProps {
  rowsByStage: Map<CanonicalStage, SendOutRow[]>;
  overStage: CanonicalStage | null;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (row: SendOutRow) => void;
  onAdvance: (row: SendOutRow) => void;
  onDelete: (row: SendOutRow) => void;
  onAdd: (stage: CanonicalStage) => void;
}

export function PipelineBoard(props: BoardProps) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
      {BOARD_STAGES.map((key) => (
        <KanbanColumn key={key} stageKey={key} rows={props.rowsByStage.get(key) ?? []} {...props} />
      ))}
    </div>
  );
}

function KanbanColumn({
  stageKey, rows, overStage, selectedIds, onToggleSelect, onOpen, onAdvance, onDelete, onAdd,
}: BoardProps & { stageKey: CanonicalStage; rows: SendOutRow[] }) {
  const cfg = canonicalConfig(stageKey);
  const { setNodeRef } = useDroppable({ id: `stage:${stageKey}` });
  const isOver = overStage === stageKey;
  const followUp = rows.filter(needsFollowUp).length;

  return (
    <div id={`sendout-col-${stageKey}`} className="flex w-80 shrink-0 flex-col scroll-mt-24">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('h-2 w-2 rounded-full shrink-0', DOT[stageKey])} />
          <span className="text-[13px] font-semibold text-foreground truncate">{cfg.label}</span>
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-card border border-card-border px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </div>
        {followUp > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-stage-hot/10 px-2 py-0.5 text-[10px] font-semibold text-stage-hot shrink-0">
            <AlertCircle className="h-3 w-3" /> {followUp} follow-up
          </span>
        )}
      </div>
      <p className="px-1 pb-2 text-[11px] text-muted-foreground">{SUBTITLE[stageKey]}</p>

      {/* Drop area */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 rounded-2xl border bg-muted/20 p-2 space-y-2 min-h-[140px] transition-colors',
          isOver ? 'border-accent/50 bg-accent/[0.04]' : 'border-card-border',
        )}
      >
        {rows.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-center text-[11px] text-muted-foreground/70">
            No candidates here
          </div>
        ) : (
          rows.map((row) => (
            <KanbanCard
              key={row.id}
              row={row}
              selected={selectedIds.has(row.id)}
              onToggleSelect={() => onToggleSelect(row.id)}
              onOpen={() => onOpen(row)}
              onAdvance={() => onAdvance(row)}
              onDelete={() => onDelete(row)}
            />
          ))
        )}

        <button
          onClick={() => onAdd(stageKey)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-card-border py-2 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-card transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Add Candidate
        </button>
      </div>
    </div>
  );
}

function KanbanCard({
  row, selected, onToggleSelect, onOpen, onAdvance, onDelete,
}: {
  row: SendOutRow; selected: boolean;
  onToggleSelect: () => void; onOpen: () => void; onAdvance: () => void; onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.id });
  const stale = needsFollowUp(row);
  const days = daysInStage(row);
  const canAdvance = !!nextStage(row.stage as CanonicalStage);
  const name = row.candidate?.full_name
    || [row.candidate?.first_name, row.candidate?.last_name].filter(Boolean).join(' ')
    || '—';
  // Submitted comp on the send-out (what we put to the client), not the
  // candidate's current — base + total ranges.
  const baseComp = formatCompRange(row.base_comp_min, row.base_comp_max);
  const totalComp = formatCompRange(row.total_comp_min, row.total_comp_max);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
      className={cn(
        'group relative rounded-xl border bg-card p-3 shadow-sm transition-all cursor-grab active:cursor-grabbing',
        'hover:shadow-md hover:-translate-y-0.5 hover:border-primary/40',
        selected ? 'border-primary ring-1 ring-primary/30' : 'border-card-border',
        stale && !selected && 'border-l-2 border-l-stage-hot',
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          className={cn(
            'absolute right-2 top-2 z-10 flex h-4 w-4 items-center justify-center rounded border border-card-border bg-card transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          aria-label="Select"
        >
          {selected && <span className="block h-2.5 w-2.5 rounded-[2px] bg-primary" />}
        </button>

        <div className="shrink-0">
          <PersonAvatar name={name} src={row.candidate?.avatar_url} size="sm" />
        </div>
        <button onClick={(e) => { e.stopPropagation(); onOpen(); }} className="min-w-0 flex-1 text-left">
          <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary">{name}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {row.candidate?.current_title || '—'}
            {row.candidate?.current_company ? ` · ${row.candidate.current_company}` : ''}
          </p>
        </button>
      </div>

      {/* Stage-aware job block: Submitting for → Submitted to → Interviewing
          for → Offered for → Placed at. Title wraps with the company under it. */}
      {row.job?.title && (
        <div className="mt-2.5 rounded-lg bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{JOB_LABEL[row.stage] ?? 'Submitting for'}</p>
          <div className="flex items-start gap-1.5 mt-0.5">
            {row.job.company_name
              ? <CompanyLogo name={row.job.company_name} domain={row.job.company?.domain} logoUrl={row.job.company?.logo_url} size="xs" className="mt-0.5" />
              : <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />}
            <div className="min-w-0">
              <span className="block text-[12px] font-medium leading-snug text-foreground line-clamp-2 break-words">{row.job.title}</span>
              {row.job.company_name && (
                <span className="block text-[11px] text-muted-foreground truncate">{row.job.company_name}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Interview rounds — which are completed / scheduled / to-schedule.
          Only shown once the card reaches the Interview stage. */}
      {stageToCanonical(row.stage) === 'interview' && (
        <InterviewStageStrip
          sendOutId={row.id}
          candidateId={row.candidate_id}
          jobId={row.job_id}
          className="mt-2"
        />
      )}

      {/* Footer chips */}
      <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
        {baseComp !== '—' && (
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-foreground">Base {baseComp}</span>
        )}
        {totalComp !== '—' && (
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-foreground">Total {totalComp}</span>
        )}
        {row.right_to_work && (
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground truncate max-w-[120px]">{row.right_to_work}</span>
        )}
        <span className={cn(
          'ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
          stale ? 'bg-stage-hot/10 text-stage-hot' : 'bg-muted/60 text-muted-foreground',
        )}>
          <Clock className="h-3 w-3" /> {days}d
        </span>
      </div>

      {/* Hover actions */}
      <div className="mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {canAdvance && (
          <button
            onClick={(e) => { e.stopPropagation(); onAdvance(); }}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            Advance <ChevronRight className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="ml-auto rounded-md p-1 text-muted-foreground/50 hover:text-stage-hot hover:bg-stage-hot/10 transition-colors"
          aria-label="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
