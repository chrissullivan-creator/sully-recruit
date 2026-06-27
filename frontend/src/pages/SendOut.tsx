import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { authHeaders } from '@/lib/api-auth';
import { useCandidate, useJobs } from '@/hooks/useData';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useProfiles } from '@/hooks/useProfiles';
import { moveStage } from '@/lib/mutations/move-stage';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import DOMPurify from 'dompurify';
import type JsPDF from 'jspdf';
import emeraldLogo from '@/assets/emerald-logo-resume.png';
import {
  ArrowLeft, ArrowRight, FileText, Sparkles, Loader2, Mail, Send, Download,
  User, IdCard, UserCircle, Clock, ClipboardCheck,
} from 'lucide-react';

const BACKEND_URL = import.meta.env.REACT_APP_BACKEND_URL || '';

type NameMode = 'all_contact' | 'name_only' | 'first_name';
const NAME_OPTIONS: { value: NameMode; label: string; desc: string; icon: any }[] = [
  { value: 'all_contact', label: 'All contact info', desc: 'Full name + phone, email, location, LinkedIn', icon: IdCard },
  { value: 'name_only', label: 'Full name only', desc: 'Keep full name, strip all contact info', icon: User },
  { value: 'first_name', label: 'First name only', desc: 'First name only, strip all contact info', icon: UserCircle },
];

type Step = 'choose' | 'formatting' | 'preview' | 'email';

/** Strip a string down to a safe but human storage-key segment. */
function safeName(s: string): string {
  return (s || 'Candidate').replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim();
}

/** Convert the imported logo asset to a data URL so html2canvas never needs the network. */
async function logoDataUrl(): Promise<string> {
  try {
    const resp = await fetch(emeraldLogo);
    const blob = await resp.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.readAsDataURL(blob);
    });
  } catch {
    return emeraldLogo;
  }
}

async function waitForImages(el: HTMLElement): Promise<void> {
  const imgs = Array.from(el.querySelectorAll('img'));
  await Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((res) => {
            img.onload = () => res();
            img.onerror = () => res();
          }),
    ),
  );
}

/** Render an HTML string to a multi-page Letter PDF via html2canvas + jsPDF. */
async function htmlToPdf(html: string): Promise<JsPDF> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-99999px;top:0;width:816px;background:#ffffff;padding:0;margin:0;';
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    await waitForImages(container);
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;
    let heightLeft = imgH;
    let position = 0;
    pdf.addImage(imgData, 'PNG', 0, position, pageW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, pageW, imgH);
      heightLeft -= pageH;
    }
    return pdf;
  } finally {
    document.body.removeChild(container);
  }
}

export default function SendOut() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const sendOutIdParam = searchParams.get('sendOutId');
  const jobIdParam = searchParams.get('jobId');

  const { user } = useAuth();
  const { data: candidate, isLoading: candLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const { data: profiles = [] } = useProfiles();

  const [step, setStep] = useState<Step>('choose');
  const [nameMode, setNameMode] = useState<NameMode>('all_contact');
  const [resumeText, setResumeText] = useState('');
  const [selectedResumeId, setSelectedResumeId] = useState<string>('');
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [formattedHtml, setFormattedHtml] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reformatting, setReformatting] = useState(false);
  const [logoSrc, setLogoSrc] = useState<string>(emeraldLogo);

  // Generated résumé artifacts (carried into the composer).
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string>('');
  const [pdfPath, setPdfPath] = useState<string>('');
  const [pdfFileName, setPdfFileName] = useState<string>('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  // Composer state.
  const [recipients, setRecipients] = useState<{ email: string; name: string; checked: boolean }[]>([]);
  const [extraRecipient, setExtraRecipient] = useState('');
  const [sendMode, setSendMode] = useState<'together' | 'individual'>('together');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [sendAt, setSendAt] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBodyHtml, setEmailBodyHtml] = useState('');
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => { logoDataUrl().then(setLogoSrc); }, []);

  // Load the originating send-out (snapshot comp / RTW / notes + job).
  const { data: sendOut } = useQuery({
    queryKey: ['send_out_one', sendOutIdParam],
    enabled: !!sendOutIdParam,
    queryFn: async () => {
      const { data, error } = await supabase.from('send_outs').select('*').eq('id', sendOutIdParam!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Résumés on file (for raw_text).
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('resumes').select('id, file_name, raw_text, ai_summary, created_at')
        .eq('candidate_id', id!).order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const selectedJob = useMemo(() => jobs.find((j: any) => j.id === selectedJobId), [jobs, selectedJobId]);

  const { data: jobContacts = [] } = useQuery({
    queryKey: ['job_contacts', selectedJobId],
    enabled: !!selectedJobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_contacts')
        .select('contact_id, contact:people!contact_id(full_name, email)')
        .eq('job_id', selectedJobId);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Seed job + résumé selection.
  useEffect(() => {
    const c = candidate as any;
    setSelectedJobId(jobIdParam || (sendOut as any)?.job_id || c?.job_id || '');
  }, [candidate, sendOut, jobIdParam]);

  useEffect(() => {
    if (resumes.length && !selectedResumeId) {
      const first = resumes[0] as any;
      setSelectedResumeId(first.id);
      setResumeText(first.raw_text || first.ai_summary || '');
    }
  }, [resumes, selectedResumeId]);

  // Seed recipients from job contacts.
  useEffect(() => {
    const rows = (jobContacts as any[]).map((jc) => jc.contact).filter((c: any) => c?.email);
    if (rows.length) {
      setRecipients(rows.map((c: any) => ({ email: c.email, name: c.full_name || c.email, checked: true })));
    }
  }, [jobContacts]);

  const displayName = useMemo(() => {
    const c = candidate as any;
    const full = c?.full_name || `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim() || 'Candidate';
    if (nameMode === 'first_name') return (c?.first_name || full.split(' ')[0] || 'Candidate').trim();
    return full;
  }, [candidate, nameMode]);

  // HTML with the logo placeholder resolved, sanitized for safe preview/PDF.
  const renderedHtml = useMemo(() => {
    if (!formattedHtml) return '';
    const withLogo = formattedHtml.replace(/__EMERALD_LOGO_SRC__/g, logoSrc);
    return DOMPurify.sanitize(withLogo, { USE_PROFILES: { html: true } });
  }, [formattedHtml, logoSrc]);

  // ── Format the résumé via AI ─────────────────────────────────────────────
  const runFormat = async (mode: NameMode, opts?: { feedback?: string; priorHtml?: string }) => {
    if (!resumeText.trim() && !opts?.priorHtml) {
      toast.error('No résumé text found — pick a résumé on file or paste one.');
      return;
    }
    const isRevision = !!opts?.priorHtml;
    if (isRevision) setReformatting(true); else setStep('formatting');
    try {
      const resp = await fetch(`${BACKEND_URL}/api/format-resume-ai`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          resume_text: resumeText,
          name_mode: mode,
          display_name: mode === 'first_name' ? (candidate as any)?.first_name : displayName,
          job_title: selectedJob?.title,
          job_description: (selectedJob as any)?.description,
          feedback: opts?.feedback,
          prior_html: opts?.priorHtml,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Formatting failed');
      setFormattedHtml(data.html);
      setStep('preview');
      setFeedback('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to format résumé');
      if (!isRevision) setStep('choose');
    } finally {
      setReformatting(false);
    }
  };

  // ── Approve résumé → generate + store the PDF, then move to email ─────────
  const approveResume = async () => {
    if (!id) return;
    setGeneratingPdf(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const fileName = `${safeName(displayName)}_Emerald.pdf`;
      const doc = await htmlToPdf(renderedHtml);
      const blob = doc.output('blob');
      const path = `${session.user.id}/${id}/formatted/${Date.now()}/${fileName}`;
      const { error: upErr } = await supabase.storage.from('resumes')
        .upload(path, blob, { upsert: true, contentType: 'application/pdf' });
      if (upErr) throw new Error(upErr.message);
      await supabase.from('formatted_resumes').insert({
        candidate_id: id,
        file_name: fileName,
        file_path: path,
        mime_type: 'application/pdf',
        file_size: blob.size,
        version_label: selectedJob ? `${(selectedJob as any).title}` : 'Emerald',
        job_id: selectedJobId || null,
        created_by: session.user.id,
      } as any);

      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
      setPdfBlobUrl(URL.createObjectURL(blob));
      setPdfPath(path);
      setPdfFileName(fileName);
      queryClient.invalidateQueries({ queryKey: ['formatted_resumes', id] });

      setStep('email');
      generateEmail();
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate PDF');
    } finally {
      setGeneratingPdf(false);
    }
  };

  // ── Ask Joe to draft the submission email ────────────────────────────────
  const fmtRange = (min: any, max: any) => {
    const f = (n: any) => (n ? `$${Number(n).toLocaleString()}` : '');
    if (min && max) return `${f(min)}–${f(max)}`;
    return f(min || max);
  };

  const generateEmail = async () => {
    if (!candidate) return;
    setGeneratingEmail(true);
    try {
      const c = candidate as any;
      const so = sendOut as any;
      const base = so ? fmtRange(so.base_comp_min, so.base_comp_max) : '';
      const bonus = so ? fmtRange(so.bonus_comp_min, so.bonus_comp_max) : '';
      const total = so ? fmtRange(so.total_comp_min, so.total_comp_max) : '';
      const resp = await fetch(`${BACKEND_URL}/api/generate-sendout-email`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          candidate_name: displayName,
          candidate_title: c.current_title,
          candidate_company: c.current_company,
          candidate_notes: c.back_of_resume_notes || c.notes,
          base_comp: base || undefined,
          bonus_comp: bonus || undefined,
          total_comp: total || undefined,
          right_to_work: so?.right_to_work || undefined,
          additional_notes: so?.additional_notes || undefined,
          job_title: selectedJob?.title,
          job_company: (selectedJob as any)?.company_name,
          job_description: (selectedJob as any)?.description,
          contact_names: recipients.filter((r) => r.checked).map((r) => r.name),
          sender_name: profiles.find((p: any) => p.email === user?.email)?.full_name || user?.user_metadata?.display_name,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Email generation failed');
      setEmailSubject(`${displayName} | ${selectedJob?.title ?? 'Candidate Submission'}`);
      const paras = String(data.body || '').split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
      setEmailBodyHtml(`<p>${data.greeting || 'Hi,'}</p>${paras}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to draft email');
    } finally {
      setGeneratingEmail(false);
    }
  };

  // Ensure a send_out exists; return its id (+ candidate_job_id).
  const ensureSendOut = async (): Promise<{ id: string; candidateJobId: string | null } | null> => {
    if (sendOutIdParam) return { id: sendOutIdParam, candidateJobId: (sendOut as any)?.candidate_job_id ?? null };
    if (!id || !selectedJobId) return null;
    const { data: existing } = await supabase
      .from('send_outs').select('id, candidate_job_id').eq('candidate_id', id).eq('job_id', selectedJobId)
      .is('deleted_at', null).limit(1).maybeSingle();
    if (existing) return { id: (existing as any).id, candidateJobId: (existing as any).candidate_job_id ?? null };
    const { data: created, error } = await supabase.from('send_outs').insert({
      candidate_id: id, job_id: selectedJobId, stage: 'ready_to_send', recruiter_id: user?.id,
    } as any).select('id, candidate_job_id').single();
    if (error) { toast.error(error.message); return null; }
    return { id: (created as any).id, candidateJobId: (created as any).candidate_job_id ?? null };
  };

  const chosenEmails = recipients.filter((r) => r.checked).map((r) => r.email);

  // ── Send via Graph, or submit through portal ─────────────────────────────
  const finish = async (mode: 'send' | 'portal') => {
    if (!id) return;
    if (mode === 'send' && chosenEmails.length === 0) { toast.error('Pick at least one recipient'); return; }
    if (mode === 'send' && scheduleOn && !sendAt) { toast.error('Pick a date & time to schedule'); return; }
    setSending(true);
    try {
      const so = await ensureSendOut();
      if (!so) throw new Error('Could not resolve a send-out (tag a job first)');

      if (mode === 'send') {
        const resp = await fetch(`${BACKEND_URL}/api/send-sendout`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({
            to: chosenEmails,
            subject: emailSubject,
            body_html: emailBodyHtml,
            attachments: pdfPath ? [{ path: pdfPath, name: pdfFileName }] : [],
            mode: sendMode,
            send_at: scheduleOn ? new Date(sendAt).toISOString() : null,
            candidate_id: id,
            job_id: selectedJobId || null,
            send_out_id: so.id,
            use_signature: true,
          }),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Send failed');
      }

      const res = await moveStage({
        sendOutId: so.id,
        candidateJobId: so.candidateJobId,
        fromStage: (sendOut as any)?.stage ?? 'ready_to_send',
        toStage: 'submitted',
        triggerSource: 'sendout',
        entityId: id,
        entityType: 'send_out',
      });
      if (!res.ok) throw new Error(res.error || 'Stage move failed');

      invalidateSendOutScope(queryClient);
      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      toast.success(
        mode === 'portal'
          ? 'Résumé saved & moved to Submission'
          : scheduleOn
            ? 'Submission scheduled & moved to Submission'
            : 'Submission email sent & moved to Submission',
      );
      navigate('/send-outs');
    } catch (err: any) {
      toast.error(err.message || 'Failed to submit');
    } finally {
      setSending(false);
    }
  };

  if (candLoading) {
    return <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin" /></div></MainLayout>;
  }

  const c = candidate as any;
  const fullName = c?.full_name || `${c?.first_name || ''} ${c?.last_name || ''}`.trim() || 'Candidate';
  const stepIndex = ['choose', 'preview', 'email'].indexOf(step === 'formatting' ? 'choose' : step);

  return (
    <MainLayout>
      <div className="px-8 py-4 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">Send Out — {fullName}</h1>
          <p className="text-sm text-muted-foreground">Format the résumé, draft the email, submit to the client</p>
        </div>
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn('h-2 w-8 rounded-full transition-colors',
              i === stepIndex ? 'bg-gold' : i < stepIndex ? 'bg-gold/40' : 'bg-muted')} />
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1" style={{ height: 'calc(100vh - 10rem)' }}>
        <div className="p-8 max-w-4xl mx-auto">

          {/* ── Step: Choose (résumé source + name treatment) ───────────── */}
          {step === 'choose' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold flex items-center gap-2"><FileText className="h-5 w-5 text-gold-deep" /> Format the résumé</h2>

              <div className="space-y-2">
                <Label>Tag to job</Label>
                <Select value={selectedJobId || 'none'} onValueChange={(v) => setSelectedJobId(v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="Select a job…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No job tagged</SelectItem>
                    {(jobs as any[]).map((j) => (
                      <SelectItem key={j.id} value={j.id}>{j.title}{j.company_name ? ` — ${j.company_name}` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Source résumé</Label>
                {resumes.length > 0 ? (
                  <Select value={selectedResumeId} onValueChange={(v) => {
                    setSelectedResumeId(v);
                    const r = (resumes as any[]).find((x) => x.id === v);
                    setResumeText(r?.raw_text || r?.ai_summary || '');
                  }}>
                    <SelectTrigger><SelectValue placeholder="Pick a résumé on file…" /></SelectTrigger>
                    <SelectContent>
                      {(resumes as any[]).map((r) => (
                        <SelectItem key={r.id} value={r.id}>{r.file_name || 'Résumé'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">No résumé on file — paste the text below.</p>
                )}
                <Textarea rows={5} value={resumeText} onChange={(e) => setResumeText(e.target.value)}
                  placeholder="Résumé text Joe will format…" />
              </div>

              <div className="space-y-3">
                <Label>How should the name &amp; contact info appear?</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {NAME_OPTIONS.map((opt) => (
                    <button key={opt.value}
                      onClick={() => { setNameMode(opt.value); runFormat(opt.value); }}
                      className="rounded-lg border-2 border-card-border p-4 text-left transition-all hover:border-gold hover:bg-gold-bg/40">
                      <opt.icon className="h-5 w-5 text-gold-deep mb-2" />
                      <p className="text-sm font-semibold">{opt.label}</p>
                      <p className="text-xs text-muted-foreground mt-1">{opt.desc}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">Pick one — Joe formats the résumé into the Emerald house style with the logo and these name rules.</p>
              </div>
            </div>
          )}

          {/* ── Step: Formatting spinner ────────────────────────────────── */}
          {step === 'formatting' && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-gold-deep" />
              <p className="text-sm text-muted-foreground">Joe is formatting the résumé in the Emerald house style…</p>
            </div>
          )}

          {/* ── Step: Preview + modify loop ─────────────────────────────── */}
          {step === 'preview' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2"><FileText className="h-5 w-5 text-gold-deep" /> Review the formatted résumé</h2>
                <Button variant="ghost" size="sm" onClick={() => setStep('choose')}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Change options
                </Button>
              </div>

              <div className="rounded-lg border border-card-border bg-white overflow-hidden">
                <div className="max-h-[60vh] overflow-y-auto p-2">
                  <div className="mx-auto bg-white" style={{ width: 816 }} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                </div>
              </div>

              <div className="rounded-lg border border-card-border bg-page-bg p-3 space-y-2">
                <Label className="text-xs">Notes for Joe (optional)</Label>
                <Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)}
                  placeholder="e.g. Shorten the 2018 role, fix the second bullet, use 'VP' not 'Vice President'…" />
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={reformatting || !feedback.trim()}
                    onClick={() => runFormat(nameMode, { feedback, priorHtml: formattedHtml })}>
                    {reformatting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                    {reformatting ? 'Re-formatting…' : 'Modify / re-run'}
                  </Button>
                  <div className="flex-1" />
                  <Button variant="gold" size="sm" disabled={generatingPdf} onClick={approveResume}>
                    {generatingPdf ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowRight className="h-4 w-4 mr-1" />}
                    {generatingPdf ? 'Building PDF…' : 'Next: draft email'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step: Email composer ────────────────────────────────────── */}
          {step === 'email' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2"><Mail className="h-5 w-5 text-gold-deep" /> Submit to client</h2>
                <Button variant="ghost" size="sm" onClick={() => setStep('preview')}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back to résumé
                </Button>
              </div>

              {/* From + send mode + schedule */}
              <div className="rounded-lg border border-card-border bg-white p-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm">
                    <span className="text-muted-foreground">From: </span>
                    <span className="font-medium">{user?.email}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs">
                      <span className={cn(sendMode === 'together' ? 'font-semibold' : 'text-muted-foreground')}>All together</span>
                      <Switch checked={sendMode === 'individual'} onCheckedChange={(v) => setSendMode(v ? 'individual' : 'together')} />
                      <span className={cn(sendMode === 'individual' ? 'font-semibold' : 'text-muted-foreground')}>Individually</span>
                    </label>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={scheduleOn} onCheckedChange={setScheduleOn} />
                    <Clock className="h-3.5 w-3.5" /> Schedule for later
                  </label>
                  {scheduleOn && (
                    <Input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="h-8 w-auto text-sm" />
                  )}
                </div>
              </div>

              {/* Recipients */}
              <div className="space-y-2">
                <Label>Recipients</Label>
                <div className="rounded-lg border border-card-border bg-white p-3 space-y-1.5">
                  {recipients.length === 0 && <p className="text-xs text-muted-foreground">No job contacts found — add a recipient below.</p>}
                  {recipients.map((r, i) => (
                    <label key={r.email + i} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={r.checked} onCheckedChange={(v) =>
                        setRecipients((prev) => prev.map((x, j) => (j === i ? { ...x, checked: !!v } : x)))} />
                      <span className="font-medium">{r.name}</span>
                      <span className="text-xs text-muted-foreground">{r.email}</span>
                    </label>
                  ))}
                  <div className="flex items-center gap-2 pt-1">
                    <Input value={extraRecipient} onChange={(e) => setExtraRecipient(e.target.value)}
                      placeholder="add email…" className="h-8 text-sm" />
                    <Button variant="outline" size="sm" onClick={() => {
                      const e = extraRecipient.trim();
                      if (e && /\S+@\S+/.test(e)) {
                        setRecipients((prev) => [...prev, { email: e, name: e, checked: true }]);
                        setExtraRecipient('');
                      } else toast.error('Enter a valid email');
                    }}>Add</Button>
                  </div>
                </div>
              </div>

              {/* Subject */}
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
              </div>

              {/* Body */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Email</Label>
                  <Button variant="ghost" size="sm" className="text-xs gap-1" disabled={generatingEmail} onClick={generateEmail}>
                    {generatingEmail ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    {generatingEmail ? 'Joe is writing…' : 'Re-draft with Joe'}
                  </Button>
                </div>
                {generatingEmail ? (
                  <div className="rounded-lg border border-gold/30 bg-gold-bg/40 p-6 flex items-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin text-gold-deep" />
                    <span className="text-sm text-muted-foreground">Drafting a sharp, direct submission email…</span>
                  </div>
                ) : (
                  <RichTextEditor value={emailBodyHtml} onChange={setEmailBodyHtml} minHeight="200px" />
                )}
                <p className="text-[11px] text-muted-foreground">Your saved signature is appended automatically on send.</p>
              </div>

              {/* Attachment */}
              <div className="rounded-lg border border-card-border bg-white p-3 flex items-center gap-3">
                <FileText className="h-5 w-5 text-gold-deep shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{pdfFileName || `${safeName(displayName)}_Emerald.pdf`}</p>
                  <p className="text-xs text-muted-foreground">Formatted résumé · attached</p>
                </div>
                {pdfBlobUrl && (
                  <a href={pdfBlobUrl} download={pdfFileName} className="text-xs text-gold-deep hover:underline flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="outline" disabled={sending} onClick={() => finish('portal')} className="gap-1">
                  <ClipboardCheck className="h-4 w-4" /> Submit through portal
                </Button>
                <Button variant="gold" disabled={sending} onClick={() => finish('send')} className="gap-1">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : scheduleOn ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                  {sending ? 'Working…' : scheduleOn ? 'Schedule send' : 'Send now'}
                </Button>
              </div>
            </div>
          )}

        </div>
      </ScrollArea>
    </MainLayout>
  );
}
