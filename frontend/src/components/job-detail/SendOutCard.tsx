import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  FileText, FileText as FileTextIcon, ExternalLink, ChevronUp, ChevronDown,
  Loader2, Upload, MoreHorizontal,
} from 'lucide-react';
import { WithdrawnReasonDialog } from '@/components/send-outs/WithdrawnReasonDialog';
import { EditSendOutNotesDialog } from '@/components/send-outs/EditSendOutNotesDialog';
import { stageToCanonical } from '@/lib/pipeline';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { formatComp, formatCompRange } from '@/lib/queries/send-outs';

// Per-sendout micro-lifecycle (the `send_outs.stage` column). Labels align with the
// canonical funnel (Submissions / Interviews / Placements / Rejections) so the dashboard
// funnel and per-job view tell the same story. "Offer" and "Withdrew" are sub-states
// not represented as their own funnel stages.
export const SEND_OUT_STAGES = [
  { value: 'submitted',    label: 'Submission',  color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interview',   color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'offer',        label: 'Offer',       color: 'bg-amber-500/15 text-amber-400' },
  { value: 'placed',       label: 'Placement',   color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejection',   color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',    color: 'bg-muted text-muted-foreground' },
];

// ── Send-out card with inline submittal notes + resume upload ─────────────────
export const SendOutCard = ({ sendOut, contacts }: { sendOut: any; contacts: any[] }) => {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(sendOut.submittal_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [changingStage, setChangingStage] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [pendingRejectStage, setPendingRejectStage] = useState<string | null>(null);

  const contact = contacts.find((c: any) => c.id === sendOut.contact_id);
  const stageCfg = SEND_OUT_STAGES.find(s => s.value === sendOut.stage) ?? SEND_OUT_STAGES[0];

  const handleStageChange = async (newStage: string) => {
    // Rejection requires the responsible party — defer to the reason dialog
    // instead of stamping the terminal stage directly.
    if (stageToCanonical(newStage) === 'withdrawn') {
      setPendingRejectStage(newStage);
      setRejectOpen(true);
      return;
    }
    setChangingStage(true);
    try {
      const updates: any = { stage: newStage };
      if (newStage === 'interviewing') updates.interview_at = new Date().toISOString();
      else if (newStage === 'offer') updates.offer_at = new Date().toISOString();
      else if (newStage === 'placed') updates.placed_at = new Date().toISOString();

      const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOut.id);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success(`Stage updated to ${SEND_OUT_STAGES.find(s => s.value === newStage)?.label}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setChangingStage(false);
    }
  };

  const handleRejectConfirm = async (party: string, reason: string) => {
    const newStage = pendingRejectStage ?? 'rejected';
    setChangingStage(true);
    try {
      const updates: any = { stage: newStage, withdrawn_by_party: party };
      if (reason && reason.trim()) updates.withdrawn_reason = reason.trim();
      const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOut.id);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success('Marked as Rejected');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setChangingStage(false);
      setRejectOpen(false);
      setPendingRejectStage(null);
    }
  };

  const saveNotes = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.from('send_outs').update({ submittal_notes: notes }).eq('id', sendOut.id);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success('Notes saved');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const uploadResume = async (file: File) => {
    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `${session.user.id}/${sendOut.id}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('send-outs').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from('send-outs').getPublicUrl(path);
      const { error: dbErr } = await supabase.from('send_outs').update({
        resume_url: urlData.publicUrl,
        resume_file_name: file.name,
      }).eq('id', sendOut.id);
      if (dbErr) throw dbErr;
      invalidateSendOutScope(queryClient);
      toast.success('Resume uploaded');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {sendOut.candidate_name ?? sendOut.candidate?.full_name ?? sendOut.candidates?.full_name ?? 'Unknown Candidate'}
            </p>
            {contact && (
              <p className="text-xs text-muted-foreground">Contact: {contact.full_name}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sendOut.resume_url && (
            <span title="Resume attached">
              <FileText className="h-3.5 w-3.5 text-accent" />
            </span>
          )}
          {sendOut.submittal_notes && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Notes</span>
          )}
          <Select
            value={sendOut.stage ?? 'submitted'}
            onValueChange={handleStageChange}
            disabled={changingStage}
          >
            <SelectTrigger
              className={cn('h-7 w-auto min-w-[110px] border-0 text-xs font-medium rounded px-2 py-0.5 gap-1', stageCfg.color)}
              onClick={(e) => e.stopPropagation()}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent onClick={(e) => e.stopPropagation()}>
              {SEND_OUT_STAGES.map(s => (
                <SelectItem key={s.value} value={s.value}>
                  <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>
                    {s.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <WithdrawnReasonDialog
            open={rejectOpen}
            onOpenChange={(v) => { setRejectOpen(v); if (!v) setPendingRejectStage(null); }}
            onConfirm={handleRejectConfirm}
          />
          {expanded
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border space-y-5">
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Submittal Resume
            </Label>
            {sendOut.resume_url ? (
              <div className="flex items-center gap-3">
                <a
                  href={sendOut.resume_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-accent hover:underline"
                  onClick={e => e.stopPropagation()}
                >
                  <FileText className="h-3.5 w-3.5" />
                  {sendOut.resume_file_name ?? 'Resume'}
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  Replace
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  : <Upload className="h-3.5 w-3.5 mr-1.5" />}
                Upload Resume
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) uploadResume(file);
                e.target.value = '';
              }}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Submittal Notes
            </Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Why is this candidate a strong fit? Add context for the client, key highlights, any caveats..."
              className="min-h-[110px] text-sm resize-none"
            />
            <Button
              variant="gold"
              size="sm"
              className="h-8"
              onClick={saveNotes}
              disabled={saving || notes === (sendOut.submittal_notes ?? '')}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Save Notes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Send-out wide table row (Send Outs tab) ─────────────────────────────────
// Same stage / withdrawal / notes behavior as SendOutCard, laid out as a
// horizontally-scrollable table row so the Send Outs tab reads like a wide
// table instead of a stack of cards.
export const SendOutTableRow = ({ sendOut, contacts, index }: { sendOut: any; contacts: any[]; index: number }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [changingStage, setChangingStage] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [pendingRejectStage, setPendingRejectStage] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  const c = sendOut.candidate ?? null;
  const name = sendOut.candidate_name ?? c?.full_name
    ?? (`${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || 'Unknown Candidate');
  const initials = ((c?.first_name?.[0] ?? '') + (c?.last_name?.[0] ?? '')).toUpperCase()
    || (name[0] ?? '?').toUpperCase();
  const contact = contacts.find((x: any) => x.id === sendOut.contact_id);
  const stageCfg = SEND_OUT_STAGES.find((s) => s.value === sendOut.stage) ?? SEND_OUT_STAGES[0];
  const hasComp = sendOut.base_comp_min != null || sendOut.base_comp_max != null
    || sendOut.bonus_comp_min != null || sendOut.bonus_comp_max != null;
  const goldTone = index % 2 === 1;
  const submitted = sendOut.sent_to_client_at ?? sendOut.created_at;
  const profileHref = c?.id ? `${c.type === 'client' ? '/contacts/' : '/candidates/'}${c.id}` : null;

  const handleStageChange = async (newStage: string) => {
    if (stageToCanonical(newStage) === 'withdrawn') {
      setPendingRejectStage(newStage); setRejectOpen(true); return;
    }
    setChangingStage(true);
    try {
      const updates: any = { stage: newStage };
      if (newStage === 'interviewing') updates.interview_at = new Date().toISOString();
      else if (newStage === 'offer') updates.offer_at = new Date().toISOString();
      else if (newStage === 'placed') updates.placed_at = new Date().toISOString();
      const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOut.id);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success(`Stage updated to ${SEND_OUT_STAGES.find((s) => s.value === newStage)?.label}`);
    } catch (e: any) { toast.error(e.message); } finally { setChangingStage(false); }
  };

  const handleRejectConfirm = async (party: string, reason: string) => {
    const newStage = pendingRejectStage ?? 'rejected';
    setChangingStage(true);
    try {
      const updates: any = { stage: newStage, withdrawn_by_party: party };
      if (reason && reason.trim()) updates.withdrawn_reason = reason.trim();
      const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOut.id);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success('Marked as Rejected');
    } catch (e: any) { toast.error(e.message); }
    finally { setChangingStage(false); setRejectOpen(false); setPendingRejectStage(null); }
  };

  return (
    <tr className="border-b border-border/60 hover:bg-muted/30 transition-colors text-sm">
      <td className="px-3 py-2.5 min-w-[210px]">
        <button
          onClick={() => profileHref && navigate(profileHref)}
          className="flex items-center gap-2.5 text-left"
        >
          {c?.avatar_url ? (
            <img src={c.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <div className={cn('h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold',
              goldTone ? 'bg-gold/15 text-gold-deep' : 'bg-emerald-light text-emerald')}>{initials}</div>
          )}
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate hover:underline">{name}</p>
            {contact && <p className="text-[11px] text-muted-foreground truncate">Contact: {contact.full_name}</p>}
          </div>
        </button>
      </td>
      <td className="px-3 py-2.5 text-muted-foreground min-w-[170px]">
        <p className="truncate">{c?.current_title ?? '—'}</p>
        {c?.current_company && <p className="text-[11px] truncate text-muted-foreground/70">{c.current_company}</p>}
      </td>
      <td className="px-3 py-2.5 text-gold-deep tabular-nums min-w-[130px] leading-tight">
        {hasComp ? (
          <>
            <div className="font-semibold"><span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-1">Base</span>{formatCompRange(sendOut.base_comp_min, sendOut.base_comp_max)}</div>
            <div className="text-xs"><span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-1">Bonus</span>{formatCompRange(sendOut.bonus_comp_min, sendOut.bonus_comp_max)}</div>
          </>
        ) : <span className="font-semibold">{formatComp(c?.target_total_comp ?? c?.target_base_comp ?? null)}</span>}
      </td>
      <td className="px-3 py-2.5 min-w-[130px]">
        <Select value={sendOut.stage ?? 'submitted'} onValueChange={handleStageChange} disabled={changingStage}>
          <SelectTrigger className={cn('h-7 w-auto min-w-[110px] border-0 text-xs font-medium rounded px-2 py-0.5 gap-1', stageCfg.color)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEND_OUT_STAGES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>{s.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <WithdrawnReasonDialog
          open={rejectOpen}
          onOpenChange={(v) => { setRejectOpen(v); if (!v) setPendingRejectStage(null); }}
          onConfirm={handleRejectConfirm}
        />
      </td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground min-w-[110px]">
        {submitted ? format(new Date(submitted), 'MMM d, yyyy') : '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground min-w-[90px]">
        {sendOut.updated_at ? format(new Date(sendOut.updated_at), 'MMM d') : '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground min-w-[160px] max-w-[240px]">
        {sendOut.submittal_notes
          ? <span className="line-clamp-2">{sendOut.submittal_notes}</span>
          : <span className="text-muted-foreground/50 italic">—</span>}
      </td>
      <td className="px-3 py-2.5 min-w-[120px]">
        <div className="flex items-center gap-1">
          {sendOut.resume_url && (
            <a href={sendOut.resume_url} target="_blank" rel="noreferrer" title="Resume"
               className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
              <FileText className="h-3.5 w-3.5" />
            </a>
          )}
          <button onClick={() => setNotesOpen(true)} title="Notes"
                  className="p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors">
            <FileTextIcon className="h-3.5 w-3.5" />
          </button>
          {profileHref && (
            <button onClick={() => navigate(profileHref)} title="Open profile"
                    className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <EditSendOutNotesDialog
          open={notesOpen}
          onOpenChange={setNotesOpen}
          sendOutId={sendOut.id}
          candidateName={name}
          jobTitle={null}
        />
      </td>
    </tr>
  );
};
