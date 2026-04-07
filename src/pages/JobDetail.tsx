import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { FieldEditDialog } from '@/components/jobs/FieldEditDialog';
import { useJob, useContacts, useJobSendOuts, useJobCandidates, useCompanies } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMemo, useState, useRef } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  ArrowLeft, Briefcase, MapPin, DollarSign, UserPlus, ListTodo, Loader2,
  Users, X, Star, Upload, FileText, ExternalLink, ChevronDown, ChevronUp, ClipboardList,
  Search, Pencil, Link as LinkIcon,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import DOMPurify from 'dompurify';

const JOB_STATUSES = [
  { value: 'new',          label: 'New',          color: 'bg-slate-500/15 text-slate-400' },
  { value: 'reached_out',  label: 'Reached Out',  color: 'bg-sky-500/15 text-sky-400' },
  { value: 'pitched',      label: 'Pitched',      color: 'bg-blue-500/15 text-blue-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'submitted',    label: 'Submitted',    color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',     color: 'bg-muted text-muted-foreground' },
];

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'interviewing', label: 'Interviewing' },
  { value: 'offer', label: 'Offer' },
  { value: 'win', label: 'Win' },
  { value: 'lost', label: 'Lost' },
  { value: 'on_hold', label: 'On Hold' },
];

// ── Clickable field wrapper ─────────────────────────────────────────────────
const EditableField = ({
  children, onClick, className,
}: {
  children: React.ReactNode; onClick: () => void; className?: string;
}) => (
  <div
    onClick={onClick}
    className={cn(
      'group relative cursor-pointer rounded-md px-2 py-1.5 -mx-2 -my-1.5 hover:bg-muted/40 transition-colors',
      className,
    )}
  >
    {children}
    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2" />
  </div>
);

// ── Send-out card with inline submittal notes + resume upload ─────────────────
const SendOutCard = ({ sendOut, contacts }: { sendOut: any; contacts: any[] }) => {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(sendOut.submittal_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const contact = contacts.find((c: any) => c.id === sendOut.contact_id);
  const stageCfg = JOB_STATUSES.find(s => s.value === sendOut.stage);

  const saveNotes = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.from('send_outs').update({ submittal_notes: notes }).eq('id', sendOut.id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['send_outs_job'] });
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
      const path = `${session.user.id}/${sendOut.id}_${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('send-outs').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from('send-outs').getPublicUrl(path);
      const { error: dbErr } = await supabase.from('send_outs').update({
        resume_url: urlData.publicUrl,
        resume_file_name: file.name,
      }).eq('id', sendOut.id);
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ['send_outs_job'] });
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
              {sendOut.candidate_name ?? sendOut.candidates?.full_name ?? 'Unknown Candidate'}
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
          {stageCfg && (
            <span className={cn('px-2 py-0.5 rounded text-xs font-medium', stageCfg.color)}>
              {stageCfg.label}
            </span>
          )}
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

// ── Main page ────────────────────────────────────────────────────────────────
const JobDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: job, isLoading } = useJob(id);
  const { data: contacts = [] } = useContacts();
  const { data: companies = [] } = useCompanies();
  const { data: sendOuts = [] } = useJobSendOuts(id);
  const { data: jobCandidates = [], isLoading: candidatesLoading } = useJobCandidates(id);

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactSearchOpen, setContactSearchOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Per-field edit dialogs
  const [editField, setEditField] = useState<{
    field: string; title: string; type: 'text' | 'richtext' | 'select';
    value: string; options?: { value: string; label: string }[]; placeholder?: string;
  } | null>(null);

  // Company edit dialog (handles both company_id and company_name)
  const [companyEditOpen, setCompanyEditOpen] = useState(false);
  const [companyEditId, setCompanyEditId] = useState('');
  const [companyEditName, setCompanyEditName] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);

  const openCompanyEdit = () => {
    setCompanyEditId(job?.company_id || '');
    setCompanyEditName(companyName || '');
    setCompanyEditOpen(true);
  };

  const handleCompanySelect = (companyId: string) => {
    if (companyId === 'none') {
      setCompanyEditId('');
      return;
    }
    const c = companies.find((co: any) => co.id === companyId);
    setCompanyEditId(companyId);
    setCompanyEditName(c?.name ?? '');
  };

  const saveCompany = async () => {
    if (!id) return;
    setSavingCompany(true);
    try {
      const { error } = await supabase.from('jobs').update({
        company_id: companyEditId || null,
        company_name: companyEditName.trim() || null,
      }).eq('id', id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Company updated');
      setCompanyEditOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update company');
    } finally {
      setSavingCompany(false);
    }
  };

  // Helper to save a single field
  const saveField = async (field: string, value: string) => {
    if (!id) return;
    try {
      const { error } = await supabase.from('jobs').update({ [field]: value || null }).eq('id', id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.success('Updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
      throw err;
    }
  };

  const openFieldEdit = (
    field: string, title: string, type: 'text' | 'richtext' | 'select',
    value: string, options?: { value: string; label: string }[], placeholder?: string,
  ) => {
    setEditField({ field, title, type, value, options, placeholder });
  };

  const { data: jobContacts = [], refetch: refetchJobContacts } = useQuery({
    queryKey: ['job_contacts', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_contacts')
        .select('id, contact_id, is_primary, role, contacts(id, full_name, email, phone, title)')
        .eq('job_id', id!)
        .order('is_primary', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const assignedContactIds = useMemo(
    () => new Set((jobContacts as any[]).map(jc => jc.contact_id)),
    [jobContacts]
  );

  const companyContactIds = useMemo(() => {
    if (!job?.company_id) return new Set<string>();
    return new Set(contacts.filter((c: any) => c.company_id === job.company_id).map((c: any) => c.id));
  }, [contacts, job?.company_id]);

  const availableSorted = useMemo(() => {
    return contacts
      .filter((c: any) => !assignedContactIds.has(c.id))
      .sort((a: any, b: any) => {
        const aMatch = companyContactIds.has(a.id) ? 0 : 1;
        const bMatch = companyContactIds.has(b.id) ? 0 : 1;
        return aMatch - bMatch;
      });
  }, [contacts, assignedContactIds, companyContactIds]);

  const addContact = async () => {
    if (!selectedContactId || !id) return;
    setAssigning(true);
    try {
      const isFirst = (jobContacts as any[]).length === 0;
      const { error } = await supabase.from('job_contacts').insert({
        job_id: id,
        contact_id: selectedContactId,
        is_primary: isFirst,
      });
      if (error) throw error;
      if (isFirst) {
        await supabase.from('jobs').update({ contact_id: selectedContactId }).eq('id', id);
        queryClient.invalidateQueries({ queryKey: ['job', id] });
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
      }
      refetchJobContacts();
      toast.success('Contact added');
      setSelectedContactId('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add contact');
    } finally {
      setAssigning(false);
    }
  };

  const removeContact = async (jobContactId: string, contactId: string, isPrimary: boolean) => {
    setRemovingId(jobContactId);
    try {
      const { error } = await supabase.from('job_contacts').delete().eq('id', jobContactId);
      if (error) throw error;
      if (isPrimary) {
        const remaining = (jobContacts as any[]).filter(jc => jc.id !== jobContactId);
        if (remaining.length > 0) {
          await supabase.from('job_contacts').update({ is_primary: true }).eq('id', remaining[0].id);
          await supabase.from('jobs').update({ contact_id: remaining[0].contact_id }).eq('id', id!);
        } else {
          await supabase.from('jobs').update({ contact_id: null }).eq('id', id!);
        }
      }
      refetchJobContacts();
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast.success('Contact removed');
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove contact');
    } finally {
      setRemovingId(null);
    }
  };

  const setPrimary = async (jobContactId: string, contactId: string) => {
    try {
      await supabase.from('job_contacts').update({ is_primary: false }).eq('job_id', id!);
      await supabase.from('job_contacts').update({ is_primary: true }).eq('id', jobContactId);
      await supabase.from('jobs').update({ contact_id: contactId }).eq('id', id!);
      refetchJobContacts();
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast.success('Primary contact updated');
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="p-8 text-muted-foreground">Loading job...</div>
      </MainLayout>
    );
  }

  if (!job) {
    return (
      <MainLayout>
        <div className="p-8 text-muted-foreground">Job not found.</div>
      </MainLayout>
    );
  }

  const companyName = job.company_name ?? (job.companies as any)?.name ?? null;
  const companyWebsite = (job.companies as any)?.website ?? null;

  // Derive logo from company website domain via Google favicon service
  const companyLogoUrl = (() => {
    if (!companyWebsite) return null;
    try {
      const domain = new URL(companyWebsite.startsWith('http') ? companyWebsite : `https://${companyWebsite}`).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    } catch {
      return null;
    }
  })();

  return (
    <MainLayout>
      <PageHeader
        title={job.title}
        description={companyName ? `at ${companyName}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate('/jobs')}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTaskPanel(true)}>
              <ListTodo className="h-4 w-4 mr-1" />
              Tasks
            </Button>
          </div>
        }
      />

      <div className="p-8 space-y-6 max-w-4xl">

        {/* ── Job Info ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              {companyLogoUrl ? (
                <img src={companyLogoUrl} alt="" className="h-6 w-6 rounded object-contain" />
              ) : (
                <Briefcase className="h-5 w-5 text-accent" />
              )}
              Job Details
              <span className="text-xs text-muted-foreground font-normal ml-auto">Click any field to edit</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              {/* Title */}
              <EditableField onClick={() => openFieldEdit('title', 'Title', 'text', job.title || '', undefined, 'e.g. Senior Software Engineer')}>
                <span className="text-muted-foreground">Title</span>
                <p className="mt-1 font-medium text-foreground">{job.title || <span className="italic text-muted-foreground">Not set</span>}</p>
              </EditableField>

              {/* Status */}
              <EditableField onClick={() => openFieldEdit('status', 'Status', 'select', job.status || 'open', STATUS_OPTIONS)}>
                <span className="text-muted-foreground">Status</span>
                <div className="mt-1"><Badge variant="secondary" className={cn(
                  job.status === 'win' && 'bg-[#1C3D2E] text-white border-[#1C3D2E]',
                  job.status === 'lost' && 'bg-[#FEF2F2] text-[#DC2626] border-[#DC2626]/20',
                )}>{STATUS_OPTIONS.find(s => s.value === job.status)?.label || job.status}</Badge></div>
              </EditableField>

              {/* Company */}
              <EditableField onClick={openCompanyEdit}>
                <span className="text-muted-foreground">Company</span>
                <p className="mt-1 font-medium text-foreground">{companyName || <span className="italic text-muted-foreground">Not set</span>}</p>
              </EditableField>

              {/* Location */}
              <EditableField onClick={() => openFieldEdit('location', 'Location', 'text', job.location || '', undefined, 'e.g. New York, NY')}>
                <span className="text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Location
                </span>
                <p className="mt-1 font-medium text-foreground">{job.location || <span className="italic text-muted-foreground">Not set</span>}</p>
              </EditableField>

              {/* Compensation */}
              <EditableField onClick={() => openFieldEdit('compensation', 'Compensation', 'text', job.compensation || '', undefined, 'e.g. $120k - $150k')}>
                <span className="text-muted-foreground flex items-center gap-1">
                  <DollarSign className="h-3 w-3" /> Compensation
                </span>
                <p className="mt-1 font-medium text-foreground">{job.compensation || <span className="italic text-muted-foreground">Not set</span>}</p>
              </EditableField>

              {/* Job URL */}
              <div className="relative">
                <EditableField onClick={() => openFieldEdit('job_url', 'Job Posting URL', 'text', (job as any).job_url || '', undefined, 'https://...')}>
                  <span className="text-muted-foreground flex items-center gap-1">
                    <LinkIcon className="h-3 w-3" /> Job URL
                  </span>
                  {(job as any).job_url ? (
                    <p className="mt-1 font-medium text-accent truncate">{(job as any).job_url}</p>
                  ) : (
                    <p className="mt-1 font-medium italic text-muted-foreground">Not set</p>
                  )}
                </EditableField>
                {(job as any).job_url && (
                  <a
                    href={(job as any).job_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute top-2 right-8 text-muted-foreground hover:text-accent transition-colors"
                    onClick={e => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>

            {/* Description — rich text display */}
            <div className="mt-5">
              <EditableField onClick={() => openFieldEdit('description', 'Description', 'richtext', job.description || '', undefined, 'Job description, requirements, qualifications...')}>
                <span className="text-sm text-muted-foreground">Description</span>
                {job.description ? (
                  <div
                    className="mt-1 text-sm text-foreground prose prose-sm max-w-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-accent [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(job.description) }}
                  />
                ) : (
                  <p className="mt-1 text-sm italic text-muted-foreground">No description yet. Click to add.</p>
                )}
              </EditableField>
            </div>
          </CardContent>
        </Card>

        {/* ── Submittal Instructions ───────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-accent" />
              Submittal Instructions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Instructions for submitting candidates to this role — format requirements, what to include, client preferences, etc.
            </p>
            <EditableField onClick={() => openFieldEdit(
              'submittal_instructions', 'Submittal Instructions', 'richtext',
              (job as any).submittal_instructions || '',
              undefined,
              'e.g. Send blind resume only. Include comp expectations and reason for looking...',
            )}>
              {(job as any).submittal_instructions ? (
                <div
                  className="text-sm text-foreground prose prose-sm max-w-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-accent [&_a]:underline"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize((job as any).submittal_instructions) }}
                />
              ) : (
                <p className="text-sm italic text-muted-foreground">No instructions yet. Click to add.</p>
              )}
            </EditableField>
          </CardContent>
        </Card>

        {/* ── Submittal Instructions (read-only callout under contacts) ────── */}
        {(job as any).submittal_instructions && (
          <div className="rounded-lg border border-accent/20 bg-accent/5 px-4 py-3 space-y-1">
            <p className="text-xs font-semibold text-accent uppercase tracking-wide flex items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> Submittal Instructions
            </p>
            <div
              className="text-sm text-foreground prose prose-sm max-w-none leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize((job as any).submittal_instructions) }}
            />
          </div>
        )}

        {/* ── Job Contacts (multi) ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-accent" />
              Job Contacts
              {(jobContacts as any[]).length > 0 && (
                <Badge variant="secondary" className="ml-1">{(jobContacts as any[]).length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(jobContacts as any[]).length === 0 ? (
              <p className="text-sm text-muted-foreground">No contacts assigned yet.</p>
            ) : (
              <div className="space-y-2">
                {(jobContacts as any[]).map(jc => {
                  const c = jc.contacts;
                  return (
                    <div key={jc.id} className="flex items-start gap-3 rounded-lg border border-border p-3 bg-card/40">
                      <div className="flex-1 min-w-0 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-foreground">{c?.full_name}</p>
                          {jc.is_primary && (
                            <span className="flex items-center gap-0.5 text-[10px] text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded font-medium">
                              <Star className="h-2.5 w-2.5 fill-current" /> Primary
                            </span>
                          )}
                          {jc.role && (
                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              {jc.role}
                            </span>
                          )}
                        </div>
                        {c?.title && <p className="text-xs text-muted-foreground mt-0.5">{c.title}</p>}
                        {c?.email && <p className="text-xs text-muted-foreground">{c.email}</p>}
                        {c?.phone && <p className="text-xs text-muted-foreground">{c.phone}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!jc.is_primary && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => setPrimary(jc.id, jc.contact_id)}
                          >
                            Set Primary
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeContact(jc.id, jc.contact_id, jc.is_primary)}
                          disabled={removingId === jc.id}
                        >
                          {removingId === jc.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <X className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add contact — searchable */}
            <div className="pt-3 border-t border-border space-y-3">
              <Label className="text-sm font-medium">Add Contact</Label>
              <div className="flex items-center gap-3">
                <div className="flex-1 relative">
                  {selectedContactId ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                      <span className="flex-1 truncate">
                        {(() => {
                          const c = (contacts as any[]).find((c: any) => c.id === selectedContactId);
                          return c ? `${c.full_name}${c.title ? ` — ${c.title}` : ''}` : 'Selected';
                        })()}
                      </span>
                      <button onClick={() => { setSelectedContactId(''); setContactSearch(''); }} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                      <Input
                        className="pl-8 h-9 text-sm"
                        placeholder="Search contacts..."
                        value={contactSearch}
                        onChange={e => { setContactSearch(e.target.value); setContactSearchOpen(true); }}
                        onFocus={() => setContactSearchOpen(true)}
                        onBlur={() => setTimeout(() => setContactSearchOpen(false), 150)}
                      />
                      {contactSearchOpen && (
                        <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-card text-foreground shadow-md max-h-56 overflow-y-auto">
                          {(() => {
                            const q = contactSearch.toLowerCase();
                            const filtered = (availableSorted as any[]).filter((c: any) =>
                              !q ||
                              c.full_name?.toLowerCase().includes(q) ||
                              c.title?.toLowerCase().includes(q) ||
                              c.email?.toLowerCase().includes(q)
                            );
                            const companyOnes = filtered.filter((c: any) => companyContactIds.has(c.id));
                            const others = filtered.filter((c: any) => !companyContactIds.has(c.id));
                            if (filtered.length === 0) return (
                              <div className="px-3 py-3 text-sm text-muted-foreground">No contacts found</div>
                            );
                            return (
                              <>
                                {companyOnes.length > 0 && (
                                  <>
                                    <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted sticky top-0">
                                      {companyName ?? 'Company'} Contacts
                                    </div>
                                    {companyOnes.map((c: any) => (
                                      <button
                                        key={c.id}
                                        className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 flex flex-col"
                                        onMouseDown={() => { setSelectedContactId(c.id); setContactSearch(''); setContactSearchOpen(false); }}
                                      >
                                        <span className="font-medium text-foreground">{c.full_name}</span>
                                        {c.title && <span className="text-xs text-muted-foreground">{c.title}</span>}
                                      </button>
                                    ))}
                                  </>
                                )}
                                {others.length > 0 && (
                                  <>
                                    {companyOnes.length > 0 && (
                                      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted sticky top-0 border-t border-border">
                                        Other Contacts
                                      </div>
                                    )}
                                    {others.map((c: any) => (
                                      <button
                                        key={c.id}
                                        className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 flex flex-col"
                                        onMouseDown={() => { setSelectedContactId(c.id); setContactSearch(''); setContactSearchOpen(false); }}
                                      >
                                        <span className="font-medium text-foreground">{c.full_name}</span>
                                        {c.title && <span className="text-xs text-muted-foreground">{c.title}</span>}
                                      </button>
                                    ))}
                                  </>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  variant="gold"
                  onClick={addContact}
                  disabled={!selectedContactId || assigning}
                >
                  {assigning && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Add
                </Button>
              </div>
              <Button variant="outline" size="sm" onClick={() => setAddContactOpen(true)}>
                <UserPlus className="h-4 w-4 mr-1" />
                Create New Contact
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Candidates Kanban Board ───────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5 text-accent" />
              Candidate Pipeline
              {jobCandidates.length > 0 && (
                <Badge variant="secondary" className="ml-1">{jobCandidates.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {candidatesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading candidates...
              </div>
            ) : jobCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6">
                No candidates linked yet. Enroll candidates in a sequence tagged to this job.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <div className="flex gap-0 min-w-max">
                  {JOB_STATUSES.map((stage, idx) => {
                    const stageCandidates = (jobCandidates as any[]).filter(c => c.job_status === stage.value);
                    const isLast = idx === JOB_STATUSES.length - 1;
                    return (
                      <div
                        key={stage.value}
                        className={cn(
                          'flex flex-col min-w-[160px] w-[160px] border-r border-border',
                          isLast && 'border-r-0'
                        )}
                      >
                        <div className={cn(
                          'px-3 py-2.5 border-b border-border flex items-center justify-between gap-1',
                        )}>
                          <span className={cn('text-xs font-semibold px-1.5 py-0.5 rounded', stage.color)}>
                            {stage.label}
                          </span>
                          {stageCandidates.length > 0 && (
                            <span className="text-xs text-muted-foreground font-medium">
                              {stageCandidates.length}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col gap-2 p-2 min-h-[80px] max-h-[420px] overflow-y-auto">
                          {stageCandidates.map((c: any) => (
                            <div
                              key={c.id}
                              onClick={() => navigate(`/candidates/${c.id}`)}
                              className="group rounded-md border border-border bg-card hover:border-accent/50 hover:bg-accent/5 p-2.5 cursor-pointer transition-colors"
                            >
                              <p className="text-xs font-medium text-foreground group-hover:text-accent leading-snug truncate">
                                {c.first_name} {c.last_name}
                              </p>
                              {c.current_title && (
                                <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                                  {c.current_title}
                                </p>
                              )}
                              {c.current_company && (
                                <p className="text-[10px] text-muted-foreground truncate">
                                  {c.current_company}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Send Outs with submittal notes + resume ──────────────────────── */}
        {(sendOuts as any[]).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-accent" />
                Send Outs
                <Badge variant="secondary" className="ml-1">{(sendOuts as any[]).length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(sendOuts as any[]).map(so => (
                <SendOutCard key={so.id} sendOut={so} contacts={contacts} />
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <AddContactDialog open={addContactOpen} onOpenChange={setAddContactOpen} />
      {taskPanel && (
        <TaskSlidePanel
          open={taskPanel}
          onOpenChange={setTaskPanel}
          entityType="job"
          entityId={job.id}
          entityName={job.title}
        />
      )}

      {/* Company edit dialog */}
      <Dialog open={companyEditOpen} onOpenChange={setCompanyEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Company</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Select Company</Label>
              <Select value={companyEditId || 'none'} onValueChange={handleCompanySelect}>
                <SelectTrigger><SelectValue placeholder="Select company" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No company</SelectItem>
                  {companies.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Company Name</Label>
              <Input
                value={companyEditName}
                onChange={(e) => setCompanyEditName(e.target.value)}
                placeholder="Or type company name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCompanyEditOpen(false)}>Cancel</Button>
            <Button variant="gold" onClick={saveCompany} disabled={savingCompany}>
              {savingCompany && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-field edit dialog */}
      {editField && (
        <FieldEditDialog
          open={!!editField}
          onOpenChange={(open) => { if (!open) setEditField(null); }}
          title={editField.title}
          fieldType={editField.type}
          value={editField.value}
          onSave={(val) => saveField(editField.field, val)}
          selectOptions={editField.options}
          placeholder={editField.placeholder}
        />
      )}
    </MainLayout>
  );
};

export default JobDetail;
