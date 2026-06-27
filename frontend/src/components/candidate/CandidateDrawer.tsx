import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CompanyLink } from '@/components/shared/EntityLinks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Mail, Phone, MessageSquare, Linkedin, ArrowLeft, ArrowRight, ExternalLink,
  Clock, Briefcase, DollarSign, Trash2, Martini, Download, CalendarPlus,
  Gift, XCircle, FileText, Repeat,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CANONICAL_PIPELINE, canonicalConfig, nextStage, prevStage,
  stageToCanonical, daysSince, type CanonicalStage,
} from '@/lib/pipeline';
import { moveStage } from '@/lib/mutations/move-stage';
import { createInterview } from '@/lib/createInterview';
import { type SendOutRow, formatComp, formatCompRange, lastTouchAt } from '@/lib/queries/send-outs';
import { supabase } from '@/integrations/supabase/client';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';
import { WithdrawnReasonDialog } from '@/components/send-outs/WithdrawnReasonDialog';
import { OfferDialog } from '@/components/send-outs/OfferDialog';
import { InterviewDetail } from '@/components/interviews/InterviewDetail';

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
  const [totalMin, setTotalMin] = useState<string>('');
  const [totalMax, setTotalMax] = useState<string>('');
  const [rtw, setRtw] = useState<string>('');
  const [additionalNotes, setAdditionalNotes] = useState<string>('');
  const [savingComp, setSavingComp] = useState(false);

  // Stage-action dialogs (Submission / Interview).
  const [rejectOpen, setRejectOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [resumeUrl, setResumeUrl] = useState<string>('');

  // Formatted résumé for the Submission/Interview/Offer views (download link).
  const { data: formattedResume } = useQuery({
    queryKey: ['drawer_formatted_resume', c?.id],
    enabled: !!c?.id && (stage === 'submitted' || stage === 'interview' || stage === 'offer'),
    queryFn: async () => {
      const { data } = await supabase
        .from('formatted_resumes')
        .select('id, file_name, file_path, created_at')
        .eq('candidate_id', c!.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    const path = (formattedResume as any)?.file_path;
    if (!path) { setResumeUrl(''); return; }
    let active = true;
    supabase.storage.from('resumes').createSignedUrl(path, 3600).then(({ data }) => {
      if (active) setResumeUrl(data?.signedUrl ?? '');
    });
    return () => { active = false; };
  }, [formattedResume]);

  const submissionEmail = row?.submission_email ?? null;

  useEffect(() => {
    setBaseMin(row?.base_comp_min != null ? String(row.base_comp_min) : '');
    setBaseMax(row?.base_comp_max != null ? String(row.base_comp_max) : '');
    setBonusMin(row?.bonus_comp_min != null ? String(row.bonus_comp_min) : '');
    setBonusMax(row?.bonus_comp_max != null ? String(row.bonus_comp_max) : '');
    setTotalMin(row?.total_comp_min != null ? String(row.total_comp_min) : '');
    setTotalMax(row?.total_comp_max != null ? String(row.total_comp_max) : '');
    setRtw(row?.right_to_work ?? '');
    setAdditionalNotes(row?.additional_notes ?? '');
  }, [row?.id, row?.base_comp_min, row?.base_comp_max, row?.bonus_comp_min, row?.bonus_comp_max, row?.total_comp_min, row?.total_comp_max, row?.right_to_work, row?.additional_notes]);

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
      String(row.total_comp_min ?? '') !== totalMin.trim() ||
      String(row.total_comp_max ?? '') !== totalMax.trim() ||
      (row.right_to_work ?? '') !== rtw.trim() ||
      (row.additional_notes ?? '') !== additionalNotes.trim());

  const saveComp = async () => {
    if (!row) return;
    const baseMinN = parseNum(baseMin);
    const baseMaxN = parseNum(baseMax);
    const bonusMinN = parseNum(bonusMin);
    const bonusMaxN = parseNum(bonusMax);
    const totalMinN = parseNum(totalMin);
    const totalMaxN = parseNum(totalMax);

    if (baseMin.trim() && baseMinN == null) { toast.error('Invalid base min (try 120k or 120000)'); return; }
    if (baseMax.trim() && baseMaxN == null) { toast.error('Invalid base max'); return; }
    if (bonusMin.trim() && bonusMinN == null) { toast.error('Invalid bonus min'); return; }
    if (bonusMax.trim() && bonusMaxN == null) { toast.error('Invalid bonus max'); return; }
    if (totalMin.trim() && totalMinN == null) { toast.error('Invalid total min'); return; }
    if (totalMax.trim() && totalMaxN == null) { toast.error('Invalid total max'); return; }
    if (baseMinN != null && baseMaxN != null && baseMinN > baseMaxN) { toast.error('Base min must be ≤ max'); return; }
    if (bonusMinN != null && bonusMaxN != null && bonusMinN > bonusMaxN) { toast.error('Bonus min must be ≤ max'); return; }
    if (totalMinN != null && totalMaxN != null && totalMinN > totalMaxN) { toast.error('Total min must be ≤ max'); return; }

    setSavingComp(true);
    try {
      const { error } = await supabase
        .from('send_outs')
        .update({
          base_comp_min: baseMinN,
          base_comp_max: baseMaxN,
          bonus_comp_min: bonusMinN,
          bonus_comp_max: bonusMaxN,
          total_comp_min: totalMinN,
          total_comp_max: totalMaxN,
          right_to_work: rtw.trim() || null,
          additional_notes: additionalNotes.trim() || null,
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

  // Placeholder for the total-comp inputs = base + bonus sum, so an empty
  // total reads as "we'll use base+bonus" rather than a bare hint.
  const totalPlaceholder = (() => {
    const bMin = parseNum(baseMin); const bMax = parseNum(baseMax);
    const boMin = parseNum(bonusMin); const boMax = parseNum(bonusMax);
    const sum = (a: number | null, b: number | null) =>
      a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    const min = sum(bMin, boMin); const max = sum(bMax, boMax);
    return {
      min: min != null ? `Min (e.g. ${Math.round(min / 1000)}k)` : 'Min',
      max: max != null ? `Max (e.g. ${Math.round(max / 1000)}k)` : 'Max',
    };
  })();

  // Save any pending submission edits, then open the Ask-Joe format/submit flow
  // for this send-out (carries job + send-out id so the flow preloads context).
  const handleAskJoe = async () => {
    if (!row || !c?.id) return;
    if (dirty) await saveComp();
    const params = new URLSearchParams({ sendOutId: row.id });
    if (row.job_id) params.set('jobId', row.job_id);
    navigate(`/candidates/${c.id}/sendout?${params.toString()}`);
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

  const afterStageChange = (msg: string) => {
    toast.success(msg);
    invalidateSendOutScope(queryClient);
    invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
  };

  // Reject from Submission / Interview — reasons captured in the dialog.
  const handleReject = async (party: string, reason: string) => {
    if (!row) return;
    const res = await moveStage({
      sendOutId: row.id,
      candidateJobId: row.candidate_job_id ?? null,
      fromStage: row.stage,
      toStage: 'withdrawn',
      triggerSource: 'drawer',
      entityId: c?.id ?? null,
      entityType: 'send_out',
      withdrawnReason: reason || null,
      rejectedByParty: party,
    });
    if (!res.ok) { toast.error(res.error ?? 'Reject failed'); return; }
    afterStageChange('Marked rejected');
    onClose();
  };

  // Move to Interview (from Submission) or add the next round (from Interview).
  // Creates an interviews row (round auto-increments) and opens it so the
  // recruiter can set the date/time; advances the funnel stage on first entry.
  const goToInterview = async (advanceStage: boolean) => {
    if (!row || !c?.id || !row.job_id) { toast.error('Need a candidate + job to schedule an interview'); return; }
    setActionBusy(true);
    try {
      if (advanceStage) {
        const res = await moveStage({
          sendOutId: row.id,
          candidateJobId: row.candidate_job_id ?? null,
          fromStage: row.stage,
          toStage: 'interview',
          triggerSource: 'drawer',
          entityId: c.id,
          entityType: 'send_out',
        });
        if (!res.ok) { toast.error(res.error ?? 'Move failed'); return; }
      }
      const newId = await createInterview({ candidateId: c.id, jobId: row.job_id, sendOutId: row.id });
      afterStageChange(advanceStage ? 'Moved to Interview' : 'Next round added');
      setInterviewId(newId);
    } catch (err: any) {
      toast.error(err.message || 'Could not create interview');
    } finally {
      setActionBusy(false);
    }
  };

  // Move to Offer (from Interview) — offer figures captured in the dialog.
  const handleOffer = async (base: number | null, bonus: number | null, details: string) => {
    if (!row) return;
    const { error: updErr } = await supabase
      .from('send_outs')
      .update({ offer_base: base, offer_bonus: bonus, offer_details: details || null } as any)
      .eq('id', row.id);
    if (updErr) { toast.error(updErr.message); return; }
    const res = await moveStage({
      sendOutId: row.id,
      candidateJobId: row.candidate_job_id ?? null,
      fromStage: row.stage,
      toStage: 'offer',
      triggerSource: 'drawer',
      entityId: c?.id ?? null,
      entityType: 'send_out',
    });
    if (!res.ok) { toast.error(res.error ?? 'Move failed'); return; }
    afterStageChange('Offer recorded');
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
                        <CompanyLink
                          companyId={(c as any).company_id}
                          name={c.current_company}
                          showLogo
                          stopPropagation
                          className="truncate"
                        />
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

              {/* Submission / Interview / Offer: formatted résumé + the
                  email that went out, plus the stage-specific next moves. */}
              {(stage === 'submitted' || stage === 'interview' || stage === 'offer') && (
                <div className="rounded-lg border border-card-border bg-white p-3 space-y-3">
                  {/* Formatted résumé (download, not preview) */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Formatted résumé</p>
                    {formattedResume ? (
                      <a
                        href={resumeUrl || undefined}
                        target="_blank" rel="noreferrer"
                        className={cn(
                          'flex items-center gap-2 rounded-md border border-card-border p-2 text-sm',
                          resumeUrl ? 'hover:border-emerald hover:bg-emerald-light' : 'opacity-60 pointer-events-none',
                        )}
                      >
                        <FileText className="h-4 w-4 text-gold-deep shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{(formattedResume as any).file_name || 'Résumé'}</span>
                        <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      </a>
                    ) : (
                      <p className="text-xs text-muted-foreground">No formatted résumé on file.</p>
                    )}
                  </div>

                  {/* Sent submission email */}
                  {submissionEmail && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        {submissionEmail.sent_at ? 'Submission email sent' : 'Submission email scheduled'}
                      </p>
                      <div className="rounded-md border border-card-border p-2 text-xs space-y-1">
                        {submissionEmail.to?.length ? <p><span className="text-muted-foreground">To: </span>{submissionEmail.to.join(', ')}</p> : null}
                        {submissionEmail.subject && <p className="font-medium">{submissionEmail.subject}</p>}
                        <p className="text-muted-foreground">
                          {submissionEmail.sent_at
                            ? `Sent ${format(new Date(submissionEmail.sent_at), 'MMM d, yyyy h:mma')}`
                            : submissionEmail.scheduled_at
                              ? `Scheduled for ${format(new Date(submissionEmail.scheduled_at), 'MMM d, yyyy h:mma')}`
                              : ''}
                        </p>
                        {submissionEmail.body_html && (
                          <div
                            className="mt-1 max-h-32 overflow-y-auto rounded bg-page-bg p-2 text-foreground [&_p]:mb-1"
                            dangerouslySetInnerHTML={{ __html: submissionEmail.body_html }}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Stage-specific next moves */}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="outline" size="sm"
                      className="gap-1 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setRejectOpen(true)}
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </Button>

                    {stage === 'submitted' && (
                      <Button variant="gold" size="sm" className="gap-1" disabled={actionBusy} onClick={() => goToInterview(true)}>
                        <CalendarPlus className="h-3.5 w-3.5" /> Move to Interview
                      </Button>
                    )}

                    {stage === 'interview' && (
                      <>
                        <Button variant="outline" size="sm" className="gap-1 border-emerald/40 text-emerald hover:bg-emerald-light" disabled={actionBusy} onClick={() => goToInterview(false)}>
                          <Repeat className="h-3.5 w-3.5" /> Next round
                        </Button>
                        <Button variant="gold" size="sm" className="gap-1" onClick={() => setOfferOpen(true)}>
                          <Gift className="h-3.5 w-3.5" /> Move to Offer
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

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
                  <p className="text-[11px] text-muted-foreground mb-1">Total comp range</p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text" inputMode="decimal"
                      placeholder={totalPlaceholder.min}
                      value={totalMin} onChange={(e) => setTotalMin(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <span className="text-muted-foreground text-xs">–</span>
                    <Input
                      type="text" inputMode="decimal"
                      placeholder={totalPlaceholder.max}
                      value={totalMax} onChange={(e) => setTotalMax(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground/70 mt-1">Leave blank to use base + bonus.</p>
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Right to work here</p>
                  <Input
                    type="text" placeholder="e.g. US Citizen, H1B, Sponsorship required"
                    value={rtw} onChange={(e) => setRtw(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Additional notes</p>
                  <Textarea
                    rows={3}
                    placeholder="Anything the client should know — context, motivations, logistics, caveats…"
                    value={additionalNotes} onChange={(e) => setAdditionalNotes(e.target.value)}
                    className="text-sm resize-none"
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

                <Button
                  variant="outline" size="sm"
                  className="w-full gap-1 border-gold/40 text-gold-deep hover:bg-gold-bg hover:border-gold"
                  onClick={handleAskJoe}
                >
                  <Martini className="h-3.5 w-3.5" /> Ask Joe — format résumé &amp; submit
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

      <WithdrawnReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        candidateName={name}
        jobTitle={j?.title ?? undefined}
        onConfirm={handleReject}
      />

      <OfferDialog
        open={offerOpen}
        onOpenChange={setOfferOpen}
        candidateName={name}
        jobTitle={j?.title ?? undefined}
        onConfirm={handleOffer}
      />

      <InterviewDetail
        interviewId={interviewId}
        open={!!interviewId}
        onOpenChange={(v) => { if (!v) setInterviewId(null); }}
        onNavigate={(iid) => setInterviewId(iid)}
      />

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
