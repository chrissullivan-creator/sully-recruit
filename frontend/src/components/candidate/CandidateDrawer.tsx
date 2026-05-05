import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Mail, Phone, MessageSquare, Linkedin, ArrowLeft, ArrowRight, ExternalLink,
  Clock, Briefcase, DollarSign, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CANONICAL_PIPELINE, canonicalConfig, nextStage, prevStage,
  stageToCanonical, daysSince, type CanonicalStage,
} from '@/lib/pipeline';
import { moveStage } from '@/lib/mutations/move-stage';
import { type SendOutRow, formatComp, lastTouchAt } from '@/lib/queries/send-outs';
import { supabase } from '@/integrations/supabase/client';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';

interface CandidateDrawerProps {
  row: SendOutRow | null;
  onClose: () => void;
  /** Optional invalidation key set, fired after a successful move. */
  invalidateKeys?: string[][];
}

export function CandidateDrawer({ row, onClose, invalidateKeys = [] }: CandidateDrawerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const open = !!row;
  const c = row?.candidate;
  const j = row?.job;
  const stage = stageToCanonical(row?.stage ?? null);
  const cfg = stage ? canonicalConfig(stage) : null;
  const days = daysSince(row?.updated_at ?? null);
  const last = row ? lastTouchAt(row) : null;
  const targetComp = formatComp(c?.target_total_comp ?? c?.target_base_comp ?? null);
  const next = stage ? nextStage(stage) : null;
  const prev = stage ? prevStage(stage) : null;
  const name = c?.full_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || '—';

  const move = async (target: CanonicalStage, source: string) => {
    if (!row) return;
    const res = await moveStage({
      sendOutId: row.id,
      candidateJobId: (row as any).candidate_job_id ?? null,
      fromStage: row.stage,
      toStage: target,
      triggerSource: source,
      entityId: c?.id ?? null,
      entityType: 'send_out',
    });
    if (!res.ok) { toast.error(res.error ?? 'Move failed'); return; }
    toast.success(`Moved to ${canonicalConfig(target).label}`);
    invalidateSendOutScope(queryClient);
    invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
    onClose();
  };

  const handleDelete = async () => {
    if (!row) return;
    setDeleting(true);
    try {
      const { error } = await softDelete('send_outs', row.id);
      if (error) throw new Error(error.message);
      toast.success('Removed from pipeline');
      invalidateSendOutScope(queryClient);
      invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
      setConfirmDelete(false);
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col bg-page-bg">
        {row && c && (
          <>
            {/* Header */}
            <SheetHeader className="px-5 pt-5 pb-4 border-b border-card-border bg-white">
              <div className="flex items-start gap-3">
                {c.avatar_url ? (
                  <img src={c.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="h-12 w-12 rounded-full bg-emerald-light text-emerald flex items-center justify-center font-semibold shrink-0">
                    {((c.first_name?.[0] ?? '') + (c.last_name?.[0] ?? '')).toUpperCase() || '?'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-base font-display text-emerald-dark text-left truncate">{name}</SheetTitle>
                  <p className="text-xs text-muted-foreground truncate text-left mt-0.5">
                    {c.current_title ?? '—'}{c.current_company ? ` · ${c.current_company}` : ''}
                  </p>
                  {cfg && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border', cfg.color)}>
                        {cfg.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{days}d in stage</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action grid */}
              <div className="grid grid-cols-4 gap-2 mt-3">
                <ActionButton icon={Mail} label="Email" disabled={!(c as any).email} onClick={() => window.open(`mailto:${(c as any).email}`)} />
                <ActionButton icon={Phone} label="Call" disabled={!(c as any).phone} onClick={() => window.open(`tel:${(c as any).phone}`)} />
                <ActionButton icon={MessageSquare} label="SMS" disabled={!(c as any).phone} onClick={() => window.open(`sms:${(c as any).phone}`)} />
                <ActionButton icon={Linkedin} label="LinkedIn" disabled={!(c as any).linkedin_url} onClick={() => window.open((c as any).linkedin_url, '_blank', 'noopener')} />
              </div>
            </SheetHeader>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Move back / advance */}
              {(prev || next) && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline" size="sm" disabled={!prev} className="flex-1 border-card-border"
                    onClick={() => prev && move(prev, 'drawer')}
                  >
                    <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                    {prev ? canonicalConfig(prev).shortLabel : '—'}
                  </Button>
                  <Button
                    variant="gold" size="sm" disabled={!next} className="flex-1"
                    onClick={() => next && move(next, 'drawer')}
                  >
                    Advance to {next ? canonicalConfig(next).shortLabel : '—'}
                    <ArrowRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              )}

              {/* Move to (jump to any other stage) */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Move to</p>
                <div className="flex flex-wrap gap-1.5">
                  {CANONICAL_PIPELINE.map((s) => {
                    if (s.key === stage) return null;
                    return (
                      <button
                        key={s.key}
                        onClick={() => move(s.key, 'drawer')}
                        className={cn(
                          'px-2 py-1 rounded-full text-[11px] font-medium border transition-colors',
                          s.key === 'offer'
                            ? 'bg-gold-bg border-gold/30 text-gold-deep hover:border-gold'
                            : 'bg-white border-card-border text-foreground hover:border-emerald hover:text-emerald',
                        )}
                      >
                        {s.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Job + comp + last touch */}
              <div className="rounded-lg border border-card-border bg-white p-3 space-y-2 text-sm">
                {j?.title && (
                  <div className="flex items-start gap-2">
                    <Briefcase className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-foreground truncate">{j.title}</p>
                      {j.company_name && <p className="text-xs text-muted-foreground truncate">{j.company_name}</p>}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <DollarSign className="h-3.5 w-3.5 text-gold-deep shrink-0" />
                  <p className="text-gold-deep font-semibold">{targetComp}</p>
                  <span className="text-xs text-muted-foreground">target</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Last touch: {last ? format(new Date(last), 'MMM d, yyyy') : '—'}
                  </p>
                </div>
              </div>

              {row.submittal_notes && (
                <div className="rounded-lg border border-card-border bg-white p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm whitespace-pre-wrap text-foreground">{row.submittal_notes}</p>
                </div>
              )}

              <Button
                variant="outline" size="sm"
                className="w-full border-card-border gap-1"
                onClick={() => { if (c.id) navigate(c.type === 'client' ? `/contacts/${c.id}` : `/candidates/${c.id}`); }}
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open full profile
              </Button>

              <Button
                variant="outline" size="sm"
                className="w-full gap-1 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove from pipeline
              </Button>
            </div>
          </>
        )}
      </SheetContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <span className="font-semibold">{name}</span>
              {' '}from the {j?.title ?? 'job'} pipeline. The person record stays — only this send-out is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-red-600 hover:bg-red-700">
              {deleting ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

function ActionButton({
  icon: Icon, label, onClick, disabled,
}: { icon: any; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-lg border py-2.5 px-1 transition-colors',
        disabled
          ? 'border-card-border bg-muted/40 text-muted-foreground/50 cursor-not-allowed'
          : 'border-card-border bg-white text-emerald hover:border-emerald hover:bg-emerald-light',
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}
