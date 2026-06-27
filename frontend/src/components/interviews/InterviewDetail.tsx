import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EntityNotesTab } from '@/components/shared/EntityNotesTab';
import { authHeaders } from '@/lib/api-auth';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Loader2, User, Briefcase, Building, Calendar, Users, FileText, Martini, Check, X, PhoneCall, Plus } from 'lucide-react';
import { CallButton } from '@/components/shared/CallButton';

// Labels are what recruiters see; the stored `value` must satisfy the DB
// interviews_interview_type_check constraint (phone_screen|video|onsite|
// technical|case_study|partner|final).
const INTERVIEW_TYPES = [
  { value: 'phone_screen', label: 'Phone' },
  { value: 'video', label: 'Video' },
  { value: 'onsite', label: 'In-person' },
  { value: 'technical', label: 'Technical assessment' },
];

// Values must satisfy interviews_outcome_check (passed|rejected|no_show|
// cancelled|pending).
const OUTCOMES = [
  { value: 'pending', label: 'Pending' },
  { value: 'passed', label: 'Passed (move on)' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'no_show', label: 'No show' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** ISO timestamptz → the `YYYY-MM-DDTHH:mm` shape a datetime-local input wants (local time). */
function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  try { return format(new Date(iso), "yyyy-MM-dd'T'HH:mm"); } catch { return ''; }
}

interface Props {
  interviewId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Jump the drawer to another interview (used after adding a new round). */
  onNavigate?: (interviewId: string) => void;
}

/**
 * Slide-over detail for a single interview. Interviews are auto-created when a
 * candidate hits the interview stage (see lib/interviewWorkflow.ts); this is
 * where the recruiter fills in the date/time, the people they're interviewing
 * with, prep notes, and the debrief. Everything stays tagged to the candidate,
 * job, and interviewer contacts.
 */
export function InterviewDetail({ interviewId, open, onOpenChange, onNavigate }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: iv, isLoading } = useQuery({
    queryKey: ['interview', interviewId],
    enabled: !!interviewId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(`*,
          candidate:people!candidate_id(id, full_name, first_name, last_name, current_title, current_company, phone, mobile_phone),
          jobs(id, title, company_name)`)
        .eq('id', interviewId!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: interviewers = [] } = useQuery({
    queryKey: ['interview_interviewers', interviewId],
    enabled: !!interviewId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interview_interviewers' as any)
        .select('id, is_primary, contact:people!contact_id(id, full_name, first_name, last_name, current_title, company_name, current_company)')
        .eq('interview_id', interviewId!)
        .order('is_primary', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  // Recorded debrief call (ai_call_notes tagged to this interview). interview_id
  // is a new column not in the generated types yet, so cast the table to any.
  const { data: debrief } = useQuery({
    queryKey: ['interview_debrief', interviewId],
    enabled: !!interviewId && open,
    queryFn: async () => {
      const { data, error } = await (supabase.from('ai_call_notes' as any) as any)
        .select('id, ai_summary, ai_action_items, transcript, recording_url, call_started_at, call_duration_formatted')
        .eq('interview_id', interviewId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (iv) {
      setForm({
        scheduled_at: toLocalInput(iv.scheduled_at),
        end_at: toLocalInput(iv.end_at),
        interview_type: iv.interview_type ?? '',
        location: iv.location ?? '',
        meeting_link: iv.meeting_link ?? '',
        round: iv.round ?? 1,
        outcome: iv.outcome ?? '',
        debrief_notes: iv.debrief_notes ?? '',
      });
    }
  }, [iv?.id]);

  const [saving, setSaving] = useState(false);
  const [addingRound, setAddingRound] = useState(false);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['interview', interviewId] });
    queryClient.invalidateQueries({ queryKey: ['interviews'] });
  };

  const patch = async (updates: any, successMsg?: string) => {
    if (!interviewId) return;
    setSaving(true);
    const { error } = await supabase
      .from('interviews')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', interviewId);
    setSaving(false);
    if (error) { toast.error(error.message || 'Save failed'); return; }
    if (successMsg) toast.success(successMsg);
    invalidate();
  };

  // Drop / update / remove the non-blocking interview marker on the owner's
  // calendar + always Chris's (server resolves the mailboxes). Fire-and-forget
  // after a schedule change; a failure here never blocks the DB save.
  const syncCalendar = async (calAction: 'upsert' | 'delete') => {
    if (!interviewId) return;
    try {
      const resp = await fetch('/api/interview-calendar-sync', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ interview_id: interviewId, action: calAction }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (calAction === 'upsert' && Array.isArray(data?.synced) && data.synced.length > 0) {
        toast.success('Added to calendar (owner + Chris) — non-blocking');
      }
    } catch (e: any) {
      toast.error(`Calendar sync failed: ${e.message}`);
    }
  };

  const saveSchedule = async () => {
    const updates: any = {
      scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
      end_at: form.end_at ? new Date(form.end_at).toISOString() : null,
      interview_type: form.interview_type || null,
      location: form.location || null,
      meeting_link: form.meeting_link || null,
      round: Number(form.round) || 1,
    };
    // First time we put a date on it, advance the lifecycle from "to schedule".
    if (updates.scheduled_at && (iv?.stage === 'to_be_scheduled' || !iv?.stage)) updates.stage = 'scheduled';
    await patch(updates, 'Interview updated');
    // Reflect the schedule onto calendars (server deletes the marker if there's no date).
    await syncCalendar('upsert');
  };

  // Spin up the next interview round for this same candidate + job as its own
  // record (own date / interviewers / notes / debrief) and jump the drawer to it.
  const addRound = async () => {
    if (!iv) return;
    setAddingRound(true);
    try {
      const { data: maxRow } = await supabase
        .from('interviews')
        .select('round')
        .eq('candidate_id', iv.candidate_id)
        .eq('job_id', iv.job_id)
        .order('round', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextRound = (Number((maxRow as any)?.round) || Number(iv.round) || 1) + 1;
      const { data, error } = await supabase
        .from('interviews')
        .insert({
          candidate_id: iv.candidate_id,
          job_id: iv.job_id,
          send_out_id: iv.send_out_id,
          owner_id: iv.owner_id,
          round: nextRound,
          stage: 'to_be_scheduled',
        } as any)
        .select('id')
        .single();
      if (error) throw error;
      toast.success(`Round ${nextRound} added`);
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      if ((data as any)?.id) onNavigate?.((data as any).id);
    } catch (e: any) {
      toast.error(e.message || 'Failed to add round');
    } finally {
      setAddingRound(false);
    }
  };

  // ── interviewer search/add ─────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const addedIds = new Set((interviewers as any[]).map((r) => r.contact?.id).filter(Boolean));
  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    const safe = q.replace(/[,%()*]/g, ' ').trim();
    let active = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('people')
        .select('id, full_name, first_name, last_name, current_title, company_name, current_company')
        .or(`full_name.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`)
        .is('deleted_at', null)
        .limit(8);
      if (active) { setResults(data ?? []); setSearching(false); }
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [search, open]);

  const addInterviewer = async (person: any) => {
    if (!interviewId) return;
    const isFirst = (interviewers as any[]).length === 0;
    const { error } = await supabase
      .from('interview_interviewers' as any)
      .insert({ interview_id: interviewId, contact_id: person.id, is_primary: isFirst });
    if (error && !String(error.message).toLowerCase().includes('duplicate')) { toast.error(error.message); return; }
    // Mirror the primary to the denormalized interviewer_* columns the dashboard/AI read.
    if (isFirst) {
      await supabase.from('interviews').update({
        interviewer_contact_id: person.id,
        interviewer_name: person.full_name || `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() || null,
        interviewer_title: person.current_title ?? null,
        interviewer_company: person.company_name || person.current_company || null,
      }).eq('id', interviewId);
    }
    setSearch(''); setResults([]);
    queryClient.invalidateQueries({ queryKey: ['interview_interviewers', interviewId] });
    invalidate();
  };

  const removeInterviewer = async (row: any) => {
    await supabase.from('interview_interviewers' as any).delete().eq('id', row.id);
    if (row.is_primary && interviewId) {
      await supabase.from('interviews')
        .update({ interviewer_contact_id: null, interviewer_name: null, interviewer_title: null, interviewer_company: null })
        .eq('id', interviewId);
    }
    queryClient.invalidateQueries({ queryKey: ['interview_interviewers', interviewId] });
    invalidate();
  };

  const cand = iv?.candidate;
  const candName = cand?.full_name || `${cand?.first_name ?? ''} ${cand?.last_name ?? ''}`.trim() || 'Candidate';
  const job = iv?.jobs;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto p-0">
        {isLoading || !iv ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col">
            {/* Header */}
            <SheetHeader className="px-6 py-5 border-b border-border text-left space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <SheetTitle className="text-lg">{candName}</SheetTitle>
                <StageBadge stage={iv.stage} cancelled={!!iv.cancelled_at} completed={!!iv.completed_at} />
                <Badge variant="secondary" className="text-[10px]">Round {iv.round ?? 1}</Badge>
              </div>
              <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => cand?.id && navigate(`/candidates/${cand.id}`)}>
                  <User className="h-3 w-3" /> {cand?.current_title || 'View candidate'}
                </button>
                {job?.title && (<>
                  <span className="text-border">·</span>
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => job?.id && navigate(`/jobs/${job.id}`)}>
                    <Briefcase className="h-3 w-3" /> {job.title}
                  </button>
                </>)}
                {job?.company_name && (<>
                  <span className="text-border">·</span>
                  <span className="inline-flex items-center gap-1"><Building className="h-3 w-3" /> {job.company_name}</span>
                </>)}
              </div>
            </SheetHeader>

            <div className="px-6 py-5 space-y-6">
              {/* Schedule */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-2"><Calendar className="h-3.5 w-3.5 text-accent" /> Schedule</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start"><Input type="datetime-local" className="h-8 text-sm" value={form.scheduled_at ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, scheduled_at: e.target.value }))} /></Field>
                  <Field label="End"><Input type="datetime-local" className="h-8 text-sm" value={form.end_at ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, end_at: e.target.value }))} /></Field>
                  <Field label="Type">
                    <Select value={form.interview_type || undefined} onValueChange={(v) => setForm((f: any) => ({ ...f, interview_type: v }))}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Type" /></SelectTrigger>
                      <SelectContent>{INTERVIEW_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Round"><Input type="number" min={1} className="h-8 text-sm" value={form.round ?? 1} onChange={(e) => setForm((f: any) => ({ ...f, round: e.target.value }))} /></Field>
                  <Field label="Location" className="col-span-2"><Input className="h-8 text-sm" placeholder="Office / room" value={form.location ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, location: e.target.value }))} /></Field>
                  <Field label="Meeting link" className="col-span-2"><Input className="h-8 text-sm" placeholder="https://…" value={form.meeting_link ?? ''} onChange={(e) => setForm((f: any) => ({ ...f, meeting_link: e.target.value }))} /></Field>
                </div>
                <Button variant="gold" size="sm" onClick={saveSchedule} disabled={saving}>
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />} Save schedule
                </Button>
                <p className="text-[11px] text-muted-foreground">Saving drops a non-blocking marker on the owner's calendar + Chris's (won't block anyone's time).</p>
              </section>

              {/* Interviewers */}
              <section className="space-y-3 border-t border-border pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-2"><Users className="h-3.5 w-3.5 text-accent" /> Interviewing with</h3>
                {(interviewers as any[]).length === 0 && <p className="text-xs text-muted-foreground">No interviewers added yet.</p>}
                <div className="flex flex-wrap gap-2">
                  {(interviewers as any[]).map((row) => {
                    const p = row.contact;
                    const nm = p?.full_name || `${p?.first_name ?? ''} ${p?.last_name ?? ''}`.trim() || 'Contact';
                    return (
                      <span key={row.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 pl-2.5 pr-1.5 py-1 text-xs">
                        <button className="hover:text-accent" onClick={() => p?.id && navigate(`/contacts/${p.id}`)}>{nm}</button>
                        {row.is_primary && <Badge variant="secondary" className="text-[8px] px-1 py-0">Primary</Badge>}
                        <button onClick={() => removeInterviewer(row)} className="text-muted-foreground hover:text-red-500" title="Remove"><X className="h-3 w-3" /></button>
                      </span>
                    );
                  })}
                </div>
                <div className="relative">
                  <Input className="h-8 text-sm" placeholder="Search people to add…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  {(results.length > 0 || searching) && search.trim().length >= 2 && (
                    <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-md max-h-56 overflow-y-auto">
                      {searching && <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>}
                      {results.filter((p) => !addedIds.has(p.id)).map((p) => {
                        const nm = p.full_name || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
                        const sub = [p.current_title, p.company_name || p.current_company].filter(Boolean).join(' · ');
                        return (
                          <button key={p.id} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 flex flex-col" onClick={() => addInterviewer(p)}>
                            <span className="font-medium text-foreground">{nm}</span>
                            {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>

              {/* Prep notes (shared notes table, entity_type='interview') */}
              <section className="space-y-2 border-t border-border pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-accent" /> Prep notes</h3>
                <EntityNotesTab entityType="interview" entityId={interviewId!} placeholder="Prep notes — what to probe, who's who, talking points…" />
              </section>

              {/* Debrief */}
              <section className="space-y-3 border-t border-border pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-2"><Martini className="h-3.5 w-3.5 text-accent" /> Debrief</h3>
                {iv.ai_summary && (
                  <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 text-sm text-foreground whitespace-pre-wrap">{iv.ai_summary}</div>
                )}
                <Field label="Outcome">
                  <Select value={form.outcome || undefined} onValueChange={(v) => { setForm((f: any) => ({ ...f, outcome: v })); patch({ outcome: v }, 'Outcome saved'); }}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Set outcome" /></SelectTrigger>
                    <SelectContent>{OUTCOMES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="Debrief notes">
                  <textarea
                    className="w-full rounded-md border border-input bg-background p-2 text-sm resize-y min-h-[90px] focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="How did it go? Feedback, next steps…"
                    value={form.debrief_notes ?? ''}
                    onChange={(e) => setForm((f: any) => ({ ...f, debrief_notes: e.target.value }))}
                  />
                </Field>
                <Button variant="outline" size="sm" onClick={() => patch({ debrief_notes: form.debrief_notes || null, debrief_at: new Date().toISOString(), debrief_source: 'manual' }, 'Debrief saved')} disabled={saving}>
                  Save debrief
                </Button>

                {/* Recorded RingCentral debrief call — its transcript/summary attaches here. */}
                <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground flex items-center gap-1.5"><PhoneCall className="h-3.5 w-3.5 text-accent" /> Recorded debrief call</span>
                    {(() => {
                      const phone = cand?.phone || cand?.mobile_phone;
                      return phone ? (
                        <CallButton phone={phone} interviewId={interviewId} variant="outline" size="sm" label="Debrief Call" title="Record a debrief call with the candidate — its notes attach here" />
                      ) : <span className="text-[11px] text-muted-foreground">No candidate phone on file</span>;
                    })()}
                  </div>
                  {debrief ? (
                    <div className="space-y-2">
                      {debrief.ai_summary && <p className="text-sm text-foreground whitespace-pre-wrap">{debrief.ai_summary}</p>}
                      {Array.isArray(debrief.ai_action_items) && debrief.ai_action_items.length > 0 && (
                        <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                          {debrief.ai_action_items.map((a: any, i: number) => <li key={i}>{typeof a === 'string' ? a : JSON.stringify(a)}</li>)}
                        </ul>
                      )}
                      {debrief.transcript && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full transcript</summary>
                          <p className="mt-1 whitespace-pre-wrap text-muted-foreground max-h-48 overflow-y-auto">{debrief.transcript}</p>
                        </details>
                      )}
                      {debrief.recording_url && <a href={debrief.recording_url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">Open recording</a>}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Place a debrief call — its transcript &amp; summary appear here automatically a couple minutes after you hang up.</p>
                  )}
                </div>
              </section>

              {/* Lifecycle actions */}
              <section className="flex items-center gap-2 border-t border-border pt-5 flex-wrap">
                <Button variant="outline" size="sm" onClick={addRound} disabled={addingRound} title="Add the next interview round for this candidate + job">
                  {addingRound ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />} New round
                </Button>
                {!iv.completed_at && !iv.cancelled_at && (
                  <Button variant="outline" size="sm" onClick={() => patch({ completed_at: new Date().toISOString(), stage: 'interview_debrief' }, 'Marked completed')}>
                    <Check className="h-3.5 w-3.5 mr-1" /> Mark completed
                  </Button>
                )}
                {!iv.cancelled_at && (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-red-500" onClick={async () => { await patch({ cancelled_at: new Date().toISOString() }, 'Interview cancelled'); await syncCalendar('delete'); }}>
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel interview
                  </Button>
                )}
              </section>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
      {children}
    </div>
  );
}

function StageBadge({ stage, cancelled, completed }: { stage?: string; cancelled?: boolean; completed?: boolean }) {
  const cfg = cancelled
    ? { label: 'Cancelled', cls: 'bg-muted text-muted-foreground border-border' }
    : completed
      ? { label: 'Completed', cls: 'bg-success/10 text-success border-success/20' }
      : stage === 'scheduled'
        ? { label: 'Scheduled', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/20' }
        : stage === 'interview_debrief'
          ? { label: 'Debrief', cls: 'bg-accent/15 text-accent border-accent/30' }
          : { label: 'To schedule', cls: 'bg-warning/15 text-warning border-warning/20' };
  return <Badge variant="secondary" className={cn('text-[10px] border', cfg.cls)}>{cfg.label}</Badge>;
}
