import { useNavigate } from 'react-router-dom';
import { Mail, MessageSquare, ArrowRight, MoreHorizontal, Linkedin, Phone } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { type SendOutRow, formatComp, lastTouchAt } from '@/lib/queries/send-outs';
import { daysSince, type CanonicalStage, nextStage, canonicalConfig } from '@/lib/pipeline';

interface CandidateRowProps {
  row: SendOutRow;
  stage: CanonicalStage;
  index: number;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onAdvance: (row: SendOutRow) => void;
  onOpen: (row: SendOutRow) => void;
}

export function CandidateRow({ row, stage, index, selected, onToggleSelect, onAdvance, onOpen }: CandidateRowProps) {
  const navigate = useNavigate();
  const c = row.candidate;
  const j = row.job;
  const name = c?.full_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || '—';
  const initials = ((c?.first_name?.[0] ?? '') + (c?.last_name?.[0] ?? '')).toUpperCase() || (name[0] ?? '?').toUpperCase();
  // Avatar tone alternates emerald / gold per spec.
  const goldTone = index % 2 === 1;
  const targetComp = formatComp(c?.target_total_comp ?? c?.target_base_comp ?? null);
  const lastTouch = lastTouchAt(row);
  const daysInStage = daysSince(row.updated_at);
  const next = nextStage(stage);
  const nextLabel = next ? canonicalConfig(next).shortLabel : null;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <tr
      onClick={() => onOpen(row)}
      className={cn(
        'cursor-pointer hover:bg-emerald-light/30 border-b border-card-border last:border-b-0 transition-colors',
        selected && 'bg-emerald-light/50',
      )}
    >
      {/* Drag handle (placeholder — DnD wired in next pass) */}
      <td className="w-8 px-2 text-center text-muted-foreground/40 group-hover:text-muted-foreground">⋮⋮</td>

      <td className="w-8 px-2" onClick={stop}>
        <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(row.id)} />
      </td>

      {/* Candidate (avatar + name) */}
      <td className="px-3 py-2.5 min-w-[200px]">
        <div className="flex items-center gap-2.5">
          {c?.avatar_url ? (
            <img src={c.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <div className={cn(
              'h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold',
              goldTone ? 'bg-gold/15 text-gold-deep' : 'bg-emerald-light text-emerald',
            )}>
              {initials}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{name}</p>
            {j?.title && (
              <p className="text-[11px] text-muted-foreground truncate">
                {j.title}{j.company_name ? ` · ${j.company_name}` : ''}
              </p>
            )}
          </div>
        </div>
      </td>

      {/* Current role */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground min-w-[160px]">
        <p className="truncate">{c?.current_title ?? '—'}</p>
        {c?.current_company && <p className="text-[11px] truncate text-muted-foreground/70">{c.current_company}</p>}
      </td>

      {/* Target comp */}
      <td className="px-3 py-2.5 text-sm font-semibold text-gold-deep tabular-nums min-w-[100px]">
        {targetComp}
      </td>

      {/* Last touch */}
      <td className="px-3 py-2.5 text-xs text-muted-foreground min-w-[110px]">
        {lastTouch ? format(new Date(lastTouch), 'MMM d') : '—'}
      </td>

      {/* Days in stage (chip) */}
      <td className="px-3 py-2.5 min-w-[80px]">
        <span className={cn(
          'inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[11px] font-medium',
          daysInStage > 7
            ? 'bg-amber-100 text-amber-800'
            : 'bg-gold-bg text-gold-deep',
        )}>
          {daysInStage}d
        </span>
      </td>

      {/* Next step */}
      <td className="px-3 py-2.5 text-xs text-muted-foreground min-w-[140px]">
        {row.submittal_notes ? (
          <span className="line-clamp-1">{row.submittal_notes}</span>
        ) : <span className="text-muted-foreground/50 italic">No next step</span>}
      </td>

      {/* Action icons */}
      <td className="px-3 py-2.5 text-right min-w-[160px]" onClick={stop}>
        <div className="flex items-center justify-end gap-1">
          {(c as any)?.email && (
            <a href={`mailto:${(c as any).email}`} title="Email"
               className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
              <Mail className="h-3.5 w-3.5" />
            </a>
          )}
          {(c as any)?.phone && (
            <a href={`sms:${(c as any).phone}`} title="SMS"
               className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
              <MessageSquare className="h-3.5 w-3.5" />
            </a>
          )}
          {(c as any)?.phone && (
            <a href={`tel:${(c as any).phone}`} title="Call"
               className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
              <Phone className="h-3.5 w-3.5" />
            </a>
          )}
          {(c as any)?.linkedin_url && (
            <a href={(c as any).linkedin_url} target="_blank" rel="noopener noreferrer" title="LinkedIn"
               className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
              <Linkedin className="h-3.5 w-3.5" />
            </a>
          )}
          {next && (
            <button
              onClick={() => onAdvance(row)}
              title={`Advance to ${nextLabel}`}
              className="p-1.5 rounded hover:bg-emerald text-muted-foreground hover:text-white transition-colors"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); if (c?.id) navigate(c.type === 'client' ? `/contacts/${c.id}` : `/candidates/${c.id}`); }}
            title="Open profile"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
