import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { type SendOutRow, formatComp, formatCompRange, lastTouchAt } from '@/lib/queries/send-outs';
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

  // Editable comp + right-to-work state. Seeds from the send_out row on
  // open; writes back via Save. We snapshot per send-out so the record
  // of what was sent stays accurate even if the candidate's profile
  // target_comp changes later.
  const [baseMin, setBaseMin] = useState<string>('');
  const [baseMax, setBaseMax] = useState<string>('');
  const [bonusMin, setBonusMin] = useState<string>('');
  const [bonusMax, setBonusMax] = useState<string>('');
  const [rtw, setRtw] = useState<string>('');
  const [savingComp, setSavingComp] = useState(false);

  useEffect(() => {
    setBaseMin(row?.base_comp_min != null ? String(row.base_comp_min) : '');
    setBaseMax(row?.base_comp_max != null ? String(row.base_comp_max) : '');
    setBonusMin(row?.bonus_comp_min != null ? String(row.bonus_comp_min) : '');
    setBonusMax(row?.bonus_comp_max != null ? String(row.bonus_comp_max) : '');
    setRtw(row?.right_to_work ?? '');
  }, [row?.id, row?.base_comp_min, row?.base_comp_max, row?.bonus_comp_min, row?.bonus_comp_max, row?.right_to_work]);

  const parseNum = (s: string): number | null => {
    const trimmed = s.trim();
    if (!trimmed) return null;
    // Accept "120k", "120000", "120,000", "$120k", "1.2M"
    const cleaned = trimmed.replace(/[$,\s]/g, '');
    const m = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([kKmM]?)$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const suffix = m[2].toLowerCase();
    if (suffix === 'k') return Math.round(n * 1_000);
    if (suffix === 'm') return Math.round(n * 1_000_000);
    return Math.round(n);
  };

  const dirty =
    !!row &&
    (String(row.base_comp_min ?? '') !== baseMin.trim() ||
      String(row.base_comp_max ?? '') !== baseMax.trim() ||
      String(row.bonus_comp_min ?? '') !== bonusMin.trim() ||
      String(row.bonus_comp_max ?? '') !== bonusMax.trim() ||
      (row.right_to_work ?? '') !== rtw.trim());

  const saveComp = async () => {
    if (!row) return;
    const baseMinN = parseNum(baseMin);
    const baseMaxN = parseNum(baseMax);
    const bonusMinN = parseNum(bonusMin);
    const bonusMaxN = parseNum(bonusMax);

    if (baseMin.trim() && baseMinN == null) { toast.error('Invalid base min (try 120k or 120000)'); return; }
    if (baseMax.trim() && baseMaxN == null) { toast.error('Invalid base max'); return; }
    if (bonusMin.trim() && bonusMinN == null) { toast.error('Invalid bonus min'); return; }
    if (bonusMax.trim() && bonusMaxN == null) { toast.error('Invalid bonus max'); return; }
    if (baseMinN != null && baseMaxN != null && baseMinN > baseMaxN) { toast.error('Base min must be ≤ max'); return; }
    if (bonusMinN != null && bonusMaxN != null && bonusMinN > bonusMaxN) { toast.error('Bonus min must be ≤ max'); return; }

    setSavingComp(true);
    try {
      const { error } = await supabase
        .from('send_outs')
        .update({
          base_comp_min: baseMinN,
          base_comp_max: baseMaxN,
          bonus_comp_min: bonusMinN,
          bonus_comp_max: bonusMaxN,
          right_to_work: rtw.trim() || null,
        })
        .eq('id', row.id);
      if (error) throw new Error(error.message);
      toast.success('Submission details saved');
      invalidateSendOutScope(queryClient);
      invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSavingComp(false);
    }
  };

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
                  <p className="text-xs text-muted-foreground truncate text-left mt-0.5 flex items-center gap-1.5">
                    <span className="truncate">{c.current_title ?? '—'}</span>
                    {c.current_company && (
                      <>
                        <span>·</span>
                        <CompanyLogo name={c.current_company} size="xs" />
                        <span className="truncate">{c.current_company}</span>
                      </>
                    )}
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

              {/* Job + candidate-target comp + last touch */}
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
                  <span className="text-xs text-muted-foreground">candidate target</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Last touch: {last ? format(new Date(last), 'MMM d, yyyy') : '—'}
                  </p>
                </div>
              </div>

              {/* Editable per-submission comp + right-to-work. Snapshotted
                  on this send_out so the record of what was sent to the
                  client stays correct even if the candidate's profile
                  changes later. */}
              <div className="rounded-lg border border-card-border bg-white p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Submitted to client
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">
                    {formatCompRange(row.base_comp_min, row.base_comp_max) !== '—' || formatCompRange(row.bonus_comp_min, row.bonus_comp_max) !== '—'
                      ? 'On record'
                      : 'Not yet recorded'}
                  </p>
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Base comp range</p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text" inputMode="decimal" placeholder="Min (e.g. 120k)"
                      value={baseMin} onChange={(e) => setBaseMin(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <span className="text-muted-foreground text-xs">–</span>
                    <Input
                      type="text" inputMode="decimal" placeholder="Max (e.g. 140k)"
                      value={baseMax} onChange={(e) => setBaseMax(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Bonus comp range</p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text" inputMode="decimal" placeholder="Min"
                      value={bonusMin} onChange={(e) => setBonusMin(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <span className="text-muted-foreground text-xs">–</span>
                    <Input
                      type="text" inputMode="decimal" placeholder="Max"
                      value={bonusMax} onChange={(e) => setBonusMax(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Right to work here</p>
                  <Input
                    type="text" placeholder="e.g. US Citizen, H1B, Sponsorship required"
                    value={rtw} onChange={(e) => setRtw(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>

                <Button
                  variant="gold" size="sm"
                  className="w-full"
                  disabled={!dirty || savingComp}
                  onClick={saveComp}
                >
                  {savingComp ? 'Saving…' : dirty ? 'Save submission details' : 'Saved'}
                </Button>
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
