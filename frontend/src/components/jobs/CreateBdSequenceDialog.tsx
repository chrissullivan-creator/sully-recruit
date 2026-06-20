import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Megaphone, Mail, Clock } from 'lucide-react';

interface BdContact {
  id: string;
  first_name: string;
  full_name: string | null;
  title: string | null;
  email: string | null;
}
interface BdEmail {
  subject: string;
  body: string;
}

const STEP_META = [
  { label: 'Email 1 · Intro', when: 'Day 0' },
  { label: 'Email 2 · Follow-up', when: '3 days later' },
  { label: 'Email 3 · Breakup', when: '3 days later' },
];

async function authHeaders(): Promise<Record<string, string>> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function CreateBdSequenceDialog({
  jobId,
  open,
  onOpenChange,
}: {
  jobId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobName, setJobName] = useState('');
  const [contacts, setContacts] = useState<BdContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emails, setEmails] = useState<BdEmail[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const resp = await fetch(`/api/jobs/${jobId}/create-bd-sequence`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ mode: 'preview' }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || 'Failed to draft BD sequence');
        if (cancelled) return;
        setJobName(data.job?.title || 'this role');
        setContacts(data.contacts || []);
        setSelected(new Set((data.contacts || []).filter((c: BdContact) => c.email).map((c: BdContact) => c.id)));
        setEmails(data.emails || []);
      } catch (err: any) {
        if (!cancelled) {
          toast.error(err.message || 'Failed to draft BD sequence');
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, jobId, onOpenChange]);

  const emailableSelected = contacts.filter((c) => selected.has(c.id) && c.email);
  const noEmailAtAll = contacts.length > 0 && contacts.every((c) => !c.email);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const setEmail = (i: number, patch: Partial<BdEmail>) =>
    setEmails((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const commit = async (launch: boolean) => {
    if (launch && emailableSelected.length === 0) {
      toast.error('Select at least one contact with an email to launch.');
      return;
    }
    if (emails.some((e) => !e.body.trim())) {
      toast.error('Every email needs a body.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`/api/jobs/${jobId}/create-bd-sequence`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          mode: 'commit',
          launch,
          emails,
          contact_ids: emailableSelected.map((c) => c.id),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to create sequence');
      toast.success(
        launch
          ? `BD sequence launched — ${data.enrolled} contact${data.enrolled === 1 ? '' : 's'} enrolled`
          : 'BD sequence saved as draft',
      );
      onOpenChange(false);
      navigate(`/sequences/${data.sequence_id}/edit`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create sequence');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-accent" /> BD sequence{jobName ? ` — ${jobName}` : ''}
          </DialogTitle>
          <DialogDescription>
            A 3-email business-development cadence (3 days apart) to the client contacts on this job. Joe
            drafted the copy — review and edit before you launch. {'{{first_name}}'} and {'{{job_name}}'} fill
            in per recipient at send time.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Joe is drafting the outreach…
          </div>
        ) : (
          <div className="space-y-5">
            {/* Recipients */}
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Recipients</Label>
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground mt-2">
                  No contacts are attached to this job yet. Add a client contact on the Contacts tab, then come back.
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {contacts.map((c) => (
                    <label
                      key={c.id}
                      className={`flex items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm ${
                        c.email ? 'cursor-pointer hover:bg-secondary/40' : 'opacity-50'
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(c.id)}
                        disabled={!c.email}
                        onCheckedChange={() => c.email && toggle(c.id)}
                      />
                      <span className="font-medium text-foreground">{c.full_name || c.first_name}</span>
                      {c.title && <span className="text-xs text-muted-foreground">· {c.title}</span>}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {c.email || 'no email on file'}
                      </span>
                    </label>
                  ))}
                  {noEmailAtAll && (
                    <p className="text-xs text-amber-500">
                      None of these contacts have an email — add one to launch, or save as a draft for now.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Emails */}
            <div className="space-y-3">
              {emails.map((em, i) => (
                <div key={i} className="rounded-lg border border-border p-3 space-y-2 bg-card/40">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Mail className="h-3.5 w-3.5 text-accent" /> {STEP_META[i]?.label}
                    <span className="ml-auto flex items-center gap-1 text-muted-foreground font-normal">
                      <Clock className="h-3 w-3" /> {STEP_META[i]?.when}
                    </span>
                  </div>
                  {i === 0 ? (
                    <Input
                      value={em.subject}
                      onChange={(e) => setEmail(i, { subject: e.target.value })}
                      placeholder="Subject line"
                      className="h-8 text-sm"
                    />
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Replies in the same thread — no subject line.</p>
                  )}
                  <Textarea
                    value={em.body}
                    onChange={(e) => setEmail(i, { body: e.target.value })}
                    rows={i === 0 ? 7 : 5}
                    className="text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="gold-outline" onClick={() => commit(false)} disabled={loading || submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Save as draft
          </Button>
          <Button
            variant="gold"
            onClick={() => commit(true)}
            disabled={loading || submitting || emailableSelected.length === 0}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Create &amp; launch{emailableSelected.length ? ` (${emailableSelected.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
