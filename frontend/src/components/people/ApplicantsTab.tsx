import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { authHeaders } from '@/lib/api-auth';
import { classifyEmail, normalizeEmail } from '@/lib/email-classifier';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import { TableSkeleton } from '@/components/shared/EmptyState';
import { FileText, ExternalLink, Download, Loader2, Mail, UserPlus, Trash2, MoreHorizontal, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const RESUME_BUCKET = 'applicant-resumes';

interface ApplicantRow {
  id: string;
  job_id: string | null;
  marketing_title_snapshot: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  compensation_expectations: string | null;
  sponsorship_requirement: string | null;
  linkedin_url: string | null;
  resume_path: string | null;
  resume_filename: string | null;
  resume_mime: string | null;
  resume_size: number | null;
  status: string | null;
  created_at: string | null;
  job?: { id: string; title: string | null; marketing_title: string | null } | null;
}

const fullName = (a: ApplicantRow) =>
  `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || '(no name)';

/**
 * Applicants tab — website applications land in the `applicants` table
 * (written by the public careers form; resumes in the private
 * `applicant-resumes` bucket). Recruiters review them here and, in bulk or
 * individually, email applicants, move them to a candidate under People, or
 * delete the record.
 */
export function ApplicantsTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [emailOpen, setEmailOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: applicants = [], isLoading } = useQuery({
    queryKey: ['applicants'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applicants' as any)
        .select('*, job:jobs(id, title, marketing_title)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ApplicantRow[];
    },
  });

  // Pre-sign resume URLs (private bucket).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const paths = applicants.map((a) => a.resume_path).filter(Boolean) as string[];
      if (paths.length === 0) return;
      const entries = await Promise.all(
        paths.map(async (p) => {
          const { data } = await supabase.storage.from(RESUME_BUCKET).createSignedUrl(p, 3600);
          return [p, data?.signedUrl ?? ''] as const;
        }),
      );
      if (!cancelled) setSignedUrls(Object.fromEntries(entries.filter(([, u]) => u)));
    })();
    return () => { cancelled = true; };
  }, [applicants]);

  const allSelected = applicants.length > 0 && applicants.every((a) => selectedIds.includes(a.id));
  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : applicants.map((a) => a.id));
  const toggleOne = (id: string) =>
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const clearSelection = () => setSelectedIds([]);

  const selectedApplicants = useMemo(
    () => applicants.filter((a) => selectedIds.includes(a.id)),
    [applicants, selectedIds],
  );

  const resumeHref = (a: ApplicantRow) => {
    const base = a.resume_path ? signedUrls[a.resume_path] : null;
    return base ?? null;
  };
  const downloadHref = (a: ApplicantRow) => {
    const base = resumeHref(a);
    if (!base) return null;
    return `${base}${base.includes('?') ? '&' : '?'}download=${encodeURIComponent(a.resume_filename ?? 'resume')}`;
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const deleteApplicants = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('applicants' as any).delete().in('id', ids);
      if (error) throw new Error(error.message);
      toast.success(`${ids.length} applicant${ids.length === 1 ? '' : 's'} deleted`);
      setSelectedIds((prev) => prev.filter((x) => !ids.includes(x)));
      queryClient.invalidateQueries({ queryKey: ['applicants'] });
      queryClient.invalidateQueries({ queryKey: ['applicants_count'] });
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete');
    } finally {
      setBusy(false);
    }
  };

  // ── Move to candidate (People) ──────────────────────────────────────────────
  const convertOne = async (a: ApplicantRow, userId: string): Promise<boolean> => {
    const email = a.email ? normalizeEmail(a.email) : '';
    const insert: Record<string, any> = {
      type: 'candidate',
      first_name: a.first_name ?? null,
      last_name: a.last_name ?? null,
      full_name: fullName(a),
      status: 'new',
      owner_user_id: userId,
      phone: a.phone ?? null,
      linkedin_url: a.linkedin_url ?? null,
      ...(email ? classifyEmail(email) : {}),
    };
    const { data: person, error } = await supabase
      .from('people').insert(insert as any).select('id').single();
    if (error || !person) throw new Error(error?.message ?? 'Insert failed');
    const candidateId = (person as any).id as string;

    // Best-effort: copy the resume into the candidate's Documents.
    if (a.resume_path) {
      try {
        const url = signedUrls[a.resume_path] ?? (await supabase.storage.from(RESUME_BUCKET).createSignedUrl(a.resume_path, 600)).data?.signedUrl;
        if (url) {
          const blob = await (await fetch(url)).blob();
          const name = a.resume_filename ?? 'resume.pdf';
          const path = `${userId}/${candidateId}/${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const { error: upErr } = await supabase.storage.from('resumes').upload(path, blob, { upsert: true, contentType: a.resume_mime ?? undefined });
          if (!upErr) {
            const { data: signed } = await supabase.storage.from('resumes').createSignedUrl(path, 3600);
            await supabase.from('resumes').insert({
              candidate_id: candidateId,
              file_name: name,
              file_path: path,
              file_url: signed?.signedUrl ?? '',
              file_size: a.resume_size ?? null,
              mime_type: a.resume_mime ?? null,
            } as any);
          }
        }
      } catch { /* resume copy is best-effort — candidate is already created */ }
    }

    // Best-effort: preserve the application context as a note.
    try {
      const ctx: string[] = [];
      const role = a.marketing_title_snapshot ?? a.job?.marketing_title ?? a.job?.title;
      if (role) ctx.push(`Applied via website for: ${role}`);
      if (a.compensation_expectations) ctx.push(`Compensation expectations: ${a.compensation_expectations}`);
      if (a.sponsorship_requirement) ctx.push(`Sponsorship: ${a.sponsorship_requirement}`);
      if (ctx.length > 0) {
        await supabase.from('notes').insert({
          entity_type: 'candidate', entity_id: candidateId,
          note: ctx.join('\n'), created_by: userId, note_source: 'applicant_conversion',
        } as any);
      }
    } catch { /* non-critical */ }

    // Mark the applicant converted (kept for audit, filtered to the bottom).
    await supabase.from('applicants' as any).update({ status: 'converted' }).eq('id', a.id);
    return true;
  };

  const moveToCandidate = async (rows: ApplicantRow[]) => {
    if (rows.length === 0) return;
    setBusy(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      let ok = 0;
      for (const a of rows) {
        try { await convertOne(a, user.id); ok++; }
        catch (e: any) { toast.error(`Failed to move ${fullName(a)}: ${e.message}`); }
      }
      if (ok > 0) {
        toast.success(`Moved ${ok} applicant${ok === 1 ? '' : 's'} to Candidates`);
        if (rows.length === 1 && ok === 1) {
          // handled by caller navigation if desired
        }
      }
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ['applicants'] });
      queryClient.invalidateQueries({ queryKey: ['applicants_count'] });
      queryClient.invalidateQueries({ queryKey: ['people'] });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <TableSkeleton rows={6} cols={6} />;

  if (applicants.length === 0) {
    return (
      <div className="text-center py-16">
        <Inbox className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
        <h3 className="text-lg font-medium mb-1">No applicants yet</h3>
        <p className="text-sm text-muted-foreground">Applications submitted through the public careers site will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5">
          <span className="text-sm font-medium text-foreground">{selectedIds.length} selected</span>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => setEmailOpen(true)}>
            <Mail className="h-3.5 w-3.5" /> Email
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => moveToCandidate(selectedApplicants)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Move to Candidates
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive" disabled={busy}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {selectedIds.length} applicant{selectedIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
                <AlertDialogDescription>This permanently removes the application record(s). This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteApplicants(selectedIds)}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button variant="ghost" size="sm" className="h-8 ml-auto" onClick={clearSelection}>Clear</Button>
        </div>
      )}

      <HorizontalTableScroll className="rounded-lg border border-border overflow-hidden" minWidth={1100}>
        <table className="w-full">
          <thead className="table-header-green">
            <tr>
              <th className="w-10 px-4 py-3"><Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" /></th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Applied For</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Comp / Sponsorship</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Resume</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Applied</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
              <th className="w-10 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {applicants.map((a) => {
              const view = resumeHref(a);
              const dl = downloadHref(a);
              return (
                <tr key={a.id} className={cn('hover:bg-muted/50 transition-colors', selectedIds.includes(a.id) && 'bg-accent/5')}>
                  <td className="px-4 py-3"><Checkbox checked={selectedIds.includes(a.id)} onCheckedChange={() => toggleOne(a.id)} aria-label={`Select ${fullName(a)}`} /></td>
                  <td className="px-4 py-3"><span className="text-sm font-medium text-foreground">{fullName(a)}</span></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {a.email && <div className="truncate max-w-[200px]">{a.email}</div>}
                    {a.phone && <div>{a.phone}</div>}
                    {a.linkedin_url && <a href={a.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>LinkedIn</a>}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {a.job_id ? (
                      <button className="text-accent hover:underline text-left" onClick={() => navigate(`/jobs/${a.job_id}`)}>
                        {a.marketing_title_snapshot ?? a.job?.marketing_title ?? a.job?.title ?? 'View job'}
                      </button>
                    ) : (a.marketing_title_snapshot ?? '—')}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {a.compensation_expectations && <div>{a.compensation_expectations}</div>}
                    {a.sponsorship_requirement && <div className="text-muted-foreground/70">Sponsorship: {a.sponsorship_requirement}</div>}
                    {!a.compensation_expectations && !a.sponsorship_requirement && '—'}
                  </td>
                  <td className="px-4 py-3">
                    {a.resume_path ? (
                      <div className="flex items-center gap-2">
                        {view ? (
                          <a href={view} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1"><ExternalLink className="h-3.5 w-3.5" /> Open</a>
                        ) : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                        {dl && <a href={dl} download={a.resume_filename ?? true} className="text-muted-foreground hover:text-foreground" title="Download"><Download className="h-3.5 w-3.5" /></a>}
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{a.created_at ? format(new Date(a.created_at), 'MMM d, yyyy') : '—'}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', a.status === 'converted' ? 'bg-emerald/10 text-emerald-dark' : 'bg-gray-100 text-gray-600')}>
                      {a.status === 'converted' ? 'Converted' : (a.status ?? 'new')}
                    </span>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1 rounded hover:bg-muted transition-colors"><MoreHorizontal className="h-4 w-4 text-muted-foreground" /></button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {view && <DropdownMenuItem onClick={() => window.open(view, '_blank')}><FileText className="h-3.5 w-3.5 mr-2" /> Open Resume</DropdownMenuItem>}
                        <DropdownMenuItem onClick={() => { setSelectedIds([a.id]); setEmailOpen(true); }}><Mail className="h-3.5 w-3.5 mr-2" /> Email</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => moveToCandidate([a])}><UserPlus className="h-3.5 w-3.5 mr-2" /> Move to Candidate</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <DropdownMenuItem className="text-destructive" onSelect={(e) => e.preventDefault()}><Trash2 className="h-3.5 w-3.5 mr-2" /> Delete</DropdownMenuItem>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete applicant?</AlertDialogTitle>
                              <AlertDialogDescription>This permanently removes {fullName(a)}'s application. This cannot be undone.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => deleteApplicants([a.id])}>Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </HorizontalTableScroll>

      <EmailApplicantsDialog
        open={emailOpen}
        onOpenChange={(v) => { setEmailOpen(v); }}
        recipients={selectedApplicants}
        onSent={() => { setEmailOpen(false); }}
      />
    </div>
  );
}

// ── Compose & send to each selected applicant via the user's mailbox ──────────
function EmailApplicantsDialog({
  open, onOpenChange, recipients, onSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recipients: ApplicantRow[];
  onSent: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const valid = recipients.filter((r) => r.email);

  const send = async () => {
    if (!body.trim()) { toast.error('Add a message body'); return; }
    setSending(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const headers = await authHeaders();
      let ok = 0;
      for (const r of valid) {
        // Simple personalization tokens.
        const first = r.first_name ?? '';
        const personalizedBody = body.replace(/\{first_name\}/g, first).replace(/\{name\}/g, fullName(r));
        const personalizedSubject = subject.replace(/\{first_name\}/g, first).replace(/\{name\}/g, fullName(r));
        try {
          const resp = await fetch('/api/trigger-send-message', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              channel: 'email',
              to: r.email,
              subject: personalizedSubject || undefined,
              body: personalizedBody,
              user_id: user.id,
            }),
          });
          if (resp.ok) ok++;
        } catch { /* counted as failure below */ }
      }
      if (ok > 0) toast.success(`Queued ${ok} email${ok === 1 ? '' : 's'}`);
      if (ok < valid.length) toast.error(`${valid.length - ok} email${valid.length - ok === 1 ? '' : 's'} failed to queue`);
      setSubject(''); setBody('');
      onSent();
    } catch (e: any) {
      toast.error(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Email {valid.length} applicant{valid.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Sends an individual email to each recipient from your connected mailbox. Use {'{first_name}'} or {'{name}'} to personalize.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Thanks for applying, {first_name}" />
          </div>
          <div>
            <Label className="text-xs">Message</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" className="min-h-[160px]" />
          </div>
          {recipients.length !== valid.length && (
            <p className="text-xs text-muted-foreground">{recipients.length - valid.length} selected applicant(s) have no email and will be skipped.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={send} disabled={sending || valid.length === 0}>
            {sending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Send to {valid.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
