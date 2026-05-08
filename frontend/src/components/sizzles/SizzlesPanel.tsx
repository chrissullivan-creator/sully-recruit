import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Loader2, Sparkles, Trash2, Edit2, X, Check } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useProfiles } from '@/hooks/useProfiles';
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning';
import { Link } from 'react-router-dom';

interface SizzleRow {
  id: string;
  person_id: string;
  job_id: string | null;
  company_id: string | null;
  title: string | null;
  body: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  person?: { id: string; full_name: string | null } | null;
  job?: { id: string; title: string | null } | null;
  company?: { id: string; name: string | null } | null;
}

/**
 * Reusable sizzles panel. Pass exactly one of personId / jobId /
 * companyId to scope the list and pre-fill that field on create.
 * The other two are still selectable inside the create form.
 *
 * Mounted by:
 *   - ContactDetail (a contact's company is the implicit scope; pass
 *     companyId from the contact row)
 *   - CompanyDetail (companyId)
 *   - JobDetail (jobId, as a tab)
 *   - CandidateDetail (personId, optional follow-up surface)
 */
interface Props {
  scope:
    | { personId: string; jobId?: never; companyId?: never }
    | { jobId: string; personId?: never; companyId?: never }
    | { companyId: string; personId?: never; jobId?: never };
}

export function SizzlesPanel({ scope }: Props) {
  const queryClient = useQueryClient();
  const { data: profiles = [] } = useProfiles();

  const scopeKey =
    'personId' in scope ? `person:${scope.personId}` :
    'jobId' in scope ? `job:${scope.jobId}` :
    `company:${scope.companyId}`;

  const { data: sizzles = [], isLoading } = useQuery({
    queryKey: ['sizzles', scopeKey],
    queryFn: async () => {
      let q = supabase
        .from('sizzles')
        .select(
          'id, person_id, job_id, company_id, title, body, created_by, created_at, updated_at, ' +
          'person:people!person_id(id, full_name), ' +
          'job:jobs!job_id(id, title), ' +
          'company:companies!company_id(id, name)',
        )
        .order('created_at', { ascending: false });
      if ('personId' in scope) q = q.eq('person_id', scope.personId);
      else if ('jobId' in scope) q = q.eq('job_id', scope.jobId);
      else q = q.eq('company_id', scope.companyId);
      const { data, error } = await q as any;
      if (error) throw error;
      return (data ?? []) as SizzleRow[];
    },
  });

  const profileMap = Object.fromEntries((profiles as any[]).map((p) => [p.id, p]));

  return (
    <div className="space-y-4">
      <CreateSizzleForm
        scope={scope}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['sizzles', scopeKey] })}
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sizzles…
        </div>
      ) : sizzles.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">
          No sizzles yet. Save one above.
        </div>
      ) : (
        <div className="space-y-3">
          {sizzles.map((s) => (
            <SizzleCard
              key={s.id}
              sizzle={s}
              authorName={profileMap[s.created_by ?? '']?.full_name ?? null}
              onMutated={() => queryClient.invalidateQueries({ queryKey: ['sizzles', scopeKey] })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateSizzleForm({ scope, onCreated }: { scope: Props['scope']; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [personId, setPersonId] = useState<string>('personId' in scope ? scope.personId : '');
  const [jobId, setJobId] = useState<string>('jobId' in scope ? scope.jobId : '');
  const [companyId, setCompanyId] = useState<string>('companyId' in scope ? scope.companyId : '');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  useUnsavedChangesWarning(open && (title.trim().length > 0 || body.trim().length > 0));

  // Auto-fill company_id from the selected job — most sizzles are
  // tied to a specific role at a specific firm, and re-typing the
  // company is friction.
  useEffect(() => {
    if (!jobId || 'companyId' in scope) return;
    (async () => {
      const { data } = await supabase.from('jobs').select('company_id').eq('id', jobId).maybeSingle();
      if ((data as any)?.company_id && !companyId) setCompanyId((data as any).company_id);
    })();
  }, [jobId, companyId, scope]);

  const reset = () => {
    setTitle('');
    setBody('');
    if (!('personId' in scope)) setPersonId('');
    if (!('jobId' in scope)) setJobId('');
    if (!('companyId' in scope)) setCompanyId('');
    setOpen(false);
  };

  const handleSave = async () => {
    if (!personId) { toast.error('Pick a person'); return; }
    if (!body.trim() && !title.trim()) { toast.error('Enter a title or body'); return; }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('sizzles').insert({
        person_id: personId,
        job_id: jobId || null,
        company_id: companyId || null,
        title: title.trim() || null,
        body: body.trim() || null,
        created_by: user?.id ?? null,
      } as any);
      if (error) throw error;
      toast.success('Sizzle saved');
      reset();
      onCreated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="h-3.5 w-3.5 mr-1.5" /> New sizzle
      </Button>
    );
  }

  return (
    <Card className="p-3 space-y-2">
      <Input
        placeholder="Sizzle title (e.g. 'Sarah Liu — VP Credit Trading at Citadel')"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        rows={6}
        placeholder="Bullet points / pitch / why-this-fit / comp / availability…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="grid grid-cols-3 gap-2">
        {!('personId' in scope) && (
          <PersonPicker value={personId} onChange={setPersonId} />
        )}
        {!('jobId' in scope) && (
          <JobPicker value={jobId} onChange={setJobId} />
        )}
        {!('companyId' in scope) && (
          <CompanyPicker value={companyId} onChange={setCompanyId} />
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Save
        </Button>
      </div>
    </Card>
  );
}

function SizzleCard({ sizzle, authorName, onMutated }: { sizzle: SizzleRow; authorName: string | null; onMutated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(sizzle.title ?? '');
  const [draftBody, setDraftBody] = useState(sizzle.body ?? '');
  const [saving, setSaving] = useState(false);
  useUnsavedChangesWarning(editing && (draftTitle !== (sizzle.title ?? '') || draftBody !== (sizzle.body ?? '')));

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('sizzles')
        .update({ title: draftTitle.trim() || null, body: draftBody.trim() || null } as any)
        .eq('id', sizzle.id);
      if (error) throw error;
      toast.success('Sizzle updated');
      setEditing(false);
      onMutated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this sizzle?')) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('sizzles').delete().eq('id', sizzle.id);
      if (error) throw error;
      toast.success('Sizzle deleted');
      onMutated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {editing ? (
            <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Title" />
          ) : (
            <h4 className="font-medium text-sm">
              {sizzle.title || <span className="text-muted-foreground italic">Untitled</span>}
            </h4>
          )}
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
            {sizzle.person?.id && (
              <Link to={`/candidates/${sizzle.person.id}`} className="hover:underline">
                {sizzle.person.full_name ?? 'Unknown person'}
              </Link>
            )}
            {sizzle.job?.id && (
              <>
                <span>•</span>
                <Link to={`/jobs/${sizzle.job.id}`} className="hover:underline">
                  {sizzle.job.title ?? 'Untitled job'}
                </Link>
              </>
            )}
            {sizzle.company?.id && (
              <>
                <span>•</span>
                <Link to={`/companies/${sizzle.company.id}`} className="hover:underline">
                  {sizzle.company.name ?? 'Unknown company'}
                </Link>
              </>
            )}
            <span>•</span>
            <span>{format(new Date(sizzle.created_at), 'MMM d, yyyy')}</span>
            {authorName && <><span>•</span><span>{authorName}</span></>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {editing ? (
            <>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-green-500" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(false); setDraftTitle(sizzle.title ?? ''); setDraftBody(sizzle.body ?? ''); }} disabled={saving}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)} disabled={saving}>
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleDelete} disabled={saving}>
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <Textarea rows={6} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
      ) : (
        sizzle.body && <p className="text-sm whitespace-pre-wrap text-foreground/90">{sizzle.body}</p>
      )}
    </Card>
  );
}

function PersonPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: people = [] } = useQuery({
    queryKey: ['sizzle-people-picker'],
    queryFn: async () => {
      const { data } = await supabase
        .from('people')
        .select('id, full_name')
        .eq('type', 'candidate')
        .order('full_name', { ascending: true })
        .limit(500);
      return data ?? [];
    },
  });
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Person</Label>
      <select className="w-full h-8 text-xs rounded border bg-background px-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick —</option>
        {people.map((p: any) => <option key={p.id} value={p.id}>{p.full_name ?? p.id}</option>)}
      </select>
    </div>
  );
}

function JobPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: jobs = [] } = useQuery({
    queryKey: ['sizzle-jobs-picker'],
    queryFn: async () => {
      const { data } = await supabase
        .from('jobs')
        .select('id, title')
        .order('created_at', { ascending: false })
        .limit(200);
      return data ?? [];
    },
  });
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Job</Label>
      <select className="w-full h-8 text-xs rounded border bg-background px-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— optional —</option>
        {jobs.map((j: any) => <option key={j.id} value={j.id}>{j.title ?? j.id}</option>)}
      </select>
    </div>
  );
}

function CompanyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: companies = [] } = useQuery({
    queryKey: ['sizzle-companies-picker'],
    queryFn: async () => {
      const { data } = await supabase
        .from('companies')
        .select('id, name')
        .order('name', { ascending: true })
        .limit(500);
      return data ?? [];
    },
  });
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Company</Label>
      <select className="w-full h-8 text-xs rounded border bg-background px-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— optional —</option>
        {companies.map((c: any) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
      </select>
    </div>
  );
}
