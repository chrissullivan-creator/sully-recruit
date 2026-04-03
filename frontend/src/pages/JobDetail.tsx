import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { TaskSlidePanel } from '@/components/tasks/TaskSlidePanel';
import { SendOutPipeline } from '@/components/pipeline/SendOutPipeline';
import { EditJobDialog } from '@/components/jobs/EditJobDialog';
import { useJob, useContacts, useJobSendOuts, useJobCandidates } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMemo, useState, useRef } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  ArrowLeft, Briefcase, MapPin, DollarSign, UserPlus, ListTodo, Loader2, Edit,
  Users, X, Star, Upload, FileText, ExternalLink, ChevronDown, ChevronUp, ClipboardList,
  Search, ChevronRight, Sparkles, MessageSquare, CheckSquare, Calendar, Play,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const JOB_STATUSES = [
  { value: 'lead',         label: 'Lead',         color: 'bg-gray-500/15 text-gray-400' },
  { value: 'reached_out',  label: 'Reached Out',  color: 'bg-sky-500/15 text-sky-400' },
  { value: 'pitch',        label: 'Pitch',        color: 'bg-blue-500/15 text-blue-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'submitted',    label: 'Submitted',    color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',     color: 'bg-muted text-muted-foreground' },
];

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
      {/* Header row — always visible */}
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

      {/* Expanded: resume + submittal notes */}
      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border space-y-5">
          {/* Resume upload */}
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

          {/* Submittal notes */}
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
  const { data: sendOuts = [] } = useJobSendOuts(id);
  const { data: jobCandidates = [], isLoading: candidatesLoading } = useJobCandidates(id);

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [taskPanel, setTaskPanel] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactSearchOpen, setContactSearchOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [editJobOpen, setEditJobOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchResults, setMatchResults] = useState<string>('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [submittalInstructions, setSubmittalInstructions] = useState<string>('');
  const [instructionsLoaded, setInstructionsLoaded] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [additionalNotes, setAdditionalNotes] = useState<string>('');
  const [additionalNotesLoaded, setAdditionalNotesLoaded] = useState(false);
  const [savingAdditionalNotes, setSavingAdditionalNotes] = useState(false);
  const [activityTab, setActivityTab] = useState<'notes' | 'tasks' | 'meetings'>('notes');
  const [jobNoteText, setJobNoteText] = useState('');
  const [savingJobNote, setSavingJobNote] = useState(false);

  // ── Activity sidebar queries ─────────────────────────────────────────
  const { data: jobNotes = [] } = useQuery({
    queryKey: ['notes', 'job', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .eq('entity_id', id!)
        .eq('entity_type', 'job')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: jobTaskLinks = [] } = useQuery({
    queryKey: ['task_links', 'job', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_links')
        .select('*, tasks(*)')
        .eq('entity_type', 'job')
        .eq('entity_id', id!);
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: jobMeetings = [] } = useQuery({
    queryKey: ['task_links', 'job_meetings', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('task_links')
        .select('*, tasks(*)')
        .eq('entity_type', 'job')
        .eq('entity_id', id!);
      if (error) throw error;
      return ((data ?? []) as any[]).filter((tl: any) => tl.tasks?.task_type === 'meeting');
    },
  });

  const { data: jobSequences = [] } = useQuery({
    queryKey: ['sequences', 'job', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sequences')
        .select('*')
        .eq('job_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const handleSaveJobNote = async () => {
    if (!jobNoteText.trim() || !id) return;
    setSavingJobNote(true);
    const { error } = await supabase.from('notes').insert({ entity_id: id, entity_type: 'job', note: jobNoteText.trim() });
    if (error) toast.error('Failed to save note');
    else { toast.success('Note saved'); setJobNoteText(''); queryClient.invalidateQueries({ queryKey: ['notes', 'job', id] }); }
    setSavingJobNote(false);
  };

  // Seed local state from job data once loaded
  if (job && !instructionsLoaded) {
    setSubmittalInstructions((job as any).submittal_instructions ?? '');
    setInstructionsLoaded(true);
  }
  if (job && !additionalNotesLoaded) {
    setAdditionalNotes((job as any).additional_notes ?? '');
    setAdditionalNotesLoaded(true);
  }

  const saveInstructions = async () => {
    if (!id) return;
    setSavingInstructions(true);
    try {
      const { error } = await supabase.from('jobs').update({ submittal_instructions: submittalInstructions }).eq('id', id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast.success('Submittal instructions saved');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingInstructions(false);
    }
  };

  const saveAdditionalNotes = async () => {
    if (!id) return;
    setSavingAdditionalNotes(true);
    try {
      const { error } = await supabase.from('jobs').update({ additional_notes: additionalNotes }).eq('id', id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast.success('Additional notes saved');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingAdditionalNotes(false);
    }
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

  // Only show contacts not yet assigned
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
      // Keep legacy contact_id in sync for the primary
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
            <Button variant="ghost" size="sm" onClick={() => setEditJobOpen(true)}>
              <Edit className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTaskPanel(true)}>
              <ListTodo className="h-4 w-4 mr-1" />
              Tasks
            </Button>
            <Button variant="gold" size="sm" onClick={() => setMatchOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1" />
              Match Candidates
            </Button>
          </div>
        }
      />

      <div className="flex flex-1 overflow-hidden">
      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-8 space-y-6">

        {/* ── Job Info ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-accent" />
              Job Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Status</span>
                <div className="mt-1"><Badge variant="secondary" className={cn(
                  job.status === 'closed_won' && 'bg-[#1C3D2E] text-white',
                  job.status === 'closed_lost' && 'bg-[#FEF2F2] text-[#DC2626]',
                  job.status === 'hot' && 'bg-[#C9A84C]/10 text-[#C9A84C]',
                  job.status === 'offer_made' && 'bg-[#2A5C42]/10 text-[#2A5C42]',
                )}>
                  {job.status === 'lead' ? 'Lead' : job.status === 'hot' ? 'Hot' : job.status === 'offer_made' ? 'Offer Made' : job.status === 'closed_won' ? 'Closed Won' : job.status === 'closed_lost' ? 'Closed Lost' : job.status}
                </Badge></div>
              </div>
              {companyName && (
                <div>
                  <span className="text-muted-foreground">Company</span>
                  <p className="mt-1 font-medium text-foreground">{companyName}</p>
                </div>
              )}
              {job.location && (
                <div>
                  <span className="text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Location
                  </span>
                  <p className="mt-1 font-medium text-foreground">{job.location}</p>
                </div>
              )}
              {job.compensation && (
                <div>
                  <span className="text-muted-foreground flex items-center gap-1">
                    <DollarSign className="h-3 w-3" /> Compensation
                  </span>
                  <p className="mt-1 font-medium text-foreground">{job.compensation}</p>
                </div>
              )}
            </div>
            {job.description && (
              <div className="mt-4">
                <span className="text-sm text-muted-foreground">Description</span>
                <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">{job.description}</p>
              </div>
            )}
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
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Instructions for submitting candidates to this role — format requirements, what to include, client preferences, etc.
            </p>
            <RichTextEditor
              value={submittalInstructions}
              onChange={setSubmittalInstructions}
              placeholder="e.g. Send blind resume only. Include comp expectations and reason for looking. Client requires GPA 3.5+. Submit to hiring manager directly, not HR..."
              minHeight="130px"
            />
            <Button
              variant="gold"
              size="sm"
              className="h-8"
              onClick={saveInstructions}
              disabled={savingInstructions || submittalInstructions === ((job as any).submittal_instructions ?? '')}
            >
              {savingInstructions && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Save Instructions
            </Button>
          </CardContent>
        </Card>

        {/* ── Additional Notes ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5 text-accent" />
              Additional Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Internal notes about this job — client intel, search nuances, comp details, exclusives, anything the team needs to know.
            </p>
            <RichTextEditor
              value={additionalNotes}
              onChange={setAdditionalNotes}
              placeholder="e.g. Client is picky on pedigree, prefers Tier 1 banks. Comp is negotiable above 200K for the right person. Search is exclusive through EOQ..."
              minHeight="130px"
            />
            <Button
              variant="gold"
              size="sm"
              className="h-8"
              onClick={saveAdditionalNotes}
              disabled={savingAdditionalNotes || additionalNotes === ((job as any).additional_notes ?? '')}
            >
              {savingAdditionalNotes && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Save Notes
            </Button>
          </CardContent>
        </Card>

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
            {/* Assigned list */}
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
                  {/* Selected display */}
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
                        placeholder="Search contacts…"
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

        {/* ── Submittal Instructions (read-only display under contacts) ────── */}
        {(job as any).submittal_instructions && (
          <div className="rounded-lg border border-accent/20 bg-accent/5 px-4 py-3 space-y-1">
            <p className="text-xs font-semibold text-accent uppercase tracking-wide flex items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> Submittal Instructions
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {(job as any).submittal_instructions}
            </p>
          </div>
        )}

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
                        {/* Column header */}
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
                        {/* Cards */}
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

        {/* ── Campaigns Tab ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Play className="h-5 w-5 text-accent" />
              Campaigns
              {jobSequences.length > 0 && (
                <Badge variant="secondary" className="ml-1">{jobSequences.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {jobSequences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No campaigns linked to this job yet.</p>
            ) : (
              <div className="space-y-2">
                {jobSequences.map((seq: any) => (
                  <div key={seq.id} className="rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{seq.name}</p>
                        {seq.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{seq.description}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {seq.enrolled_count != null && (
                          <span className="text-xs text-muted-foreground">{seq.enrolled_count} enrolled</span>
                        )}
                        <Badge variant="secondary" className={cn(
                          'text-xs',
                          seq.status === 'active' && 'bg-green-500/15 text-green-400',
                          seq.status === 'paused' && 'bg-yellow-500/15 text-yellow-400',
                          seq.status === 'draft' && 'bg-gray-500/15 text-gray-400',
                        )}>
                          {seq.status ? seq.status.charAt(0).toUpperCase() + seq.status.slice(1) : 'Unknown'}
                        </Badge>
                        {seq.created_at && (
                          <span className="text-xs text-muted-foreground">{format(new Date(seq.created_at), 'MMM d, yyyy')}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Activity Sidebar ──────────────────────────────────────────────── */}
      <aside className="w-[28%] min-w-[300px] shrink-0 border-l border-border flex flex-col overflow-hidden bg-card/30">
        <div className="px-4 pt-4 pb-2 border-b border-border">
          <div className="flex gap-1">
            <button
              onClick={() => setActivityTab('notes')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                activityTab === 'notes' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" /> Notes
            </button>
            <button
              onClick={() => setActivityTab('tasks')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                activityTab === 'tasks' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <CheckSquare className="h-3.5 w-3.5" /> Tasks
            </button>
            <button
              onClick={() => setActivityTab('meetings')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                activityTab === 'meetings' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <Calendar className="h-3.5 w-3.5" /> Meetings
            </button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {/* Notes sub-tab */}
            {activityTab === 'notes' && (
              <>
                <div className="space-y-2">
                  <RichTextEditor
                    value={jobNoteText}
                    onChange={setJobNoteText}
                    placeholder="Add a note..."
                    minHeight="70px"
                  />
                  <Button variant="gold" size="sm" className="h-7 text-xs" onClick={handleSaveJobNote} disabled={savingJobNote || !jobNoteText.trim()}>
                    {savingJobNote && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save Note
                  </Button>
                </div>
                {(jobNotes as any[]).length > 0 ? (
                  <div className="space-y-2">
                    {(jobNotes as any[]).map((n: any) => (
                      <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-3">
                        <div className="text-sm prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: n.note }} />
                        <p className="text-[10px] text-muted-foreground mt-1.5">{n.created_at ? format(new Date(n.created_at), 'MMM d, yyyy h:mm a') : ''}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No notes yet.</p>
                )}
              </>
            )}

            {/* Tasks sub-tab */}
            {activityTab === 'tasks' && (
              <>
                {(jobTaskLinks as any[]).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tasks linked to this job.</p>
                ) : (
                  <div className="space-y-2">
                    {(jobTaskLinks as any[]).map((tl: any) => {
                      const t = tl.tasks;
                      if (!t) return null;
                      return (
                        <div key={tl.id} className="rounded-md border border-border bg-secondary/50 p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                            <Badge variant="secondary" className={cn(
                              'text-[9px]',
                              t.status === 'completed' && 'bg-green-500/15 text-green-400',
                              t.status === 'in_progress' && 'bg-blue-500/15 text-blue-400',
                              t.status === 'pending' && 'bg-gray-500/15 text-gray-400',
                            )}>
                              {t.status ?? 'pending'}
                            </Badge>
                          </div>
                          {t.description && <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>}
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {t.due_date && <span>Due: {format(new Date(t.due_date), 'MMM d, yyyy')}</span>}
                            {t.task_type && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{t.task_type}</Badge>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* Meetings sub-tab */}
            {activityTab === 'meetings' && (
              <>
                {(jobMeetings as any[]).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No meetings linked to this job.</p>
                ) : (
                  <div className="space-y-2">
                    {(jobMeetings as any[]).map((tl: any) => {
                      const t = tl.tasks;
                      if (!t) return null;
                      return (
                        <div key={tl.id} className="rounded-md border border-border bg-secondary/50 p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                            <Badge variant="secondary" className={cn(
                              'text-[9px]',
                              t.status === 'completed' && 'bg-green-500/15 text-green-400',
                              t.status === 'scheduled' && 'bg-blue-500/15 text-blue-400',
                            )}>
                              {t.status ?? 'scheduled'}
                            </Badge>
                          </div>
                          {t.description && <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>}
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {t.due_date && (
                              <span className="flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {format(new Date(t.due_date), 'MMM d, yyyy h:mm a')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </aside>
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
      <EditJobDialog open={editJobOpen} onOpenChange={setEditJobOpen} job={job} />

      {/* Match Candidates Dialog */}
      <Dialog open={matchOpen} onOpenChange={(v) => { setMatchOpen(v); if (!v) setMatchResults(''); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-accent" />
              Match Candidates — {job.title}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-[200px]">
            {matching && !matchResults ? (
              <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Joe is analyzing your candidate database and resumes...</span>
              </div>
            ) : matchResults ? (
              <div className="prose prose-sm max-w-none text-foreground whitespace-pre-wrap px-1">
                {matchResults}
                {matching && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground ml-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </span>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
                <Sparkles className="h-10 w-10 opacity-30" />
                <p className="text-sm text-center max-w-md">
                  Joe will search your candidate database (including resumes) and rank the best matches for this role based on skills, experience, and background.
                </p>
                <Button
                  variant="gold"
                  onClick={async () => {
                    setMatching(true);
                    setMatchResults('');
                    try {
                      const backendUrl = import.meta.env.REACT_APP_BACKEND_URL || '';
                      const resp = await fetch(`${backendUrl}/api/match-candidates-to-job`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          job_title: job.title,
                          job_company: companyName || (job as any).company_name,
                          job_location: job.location,
                          job_description: (job as any).description || (job as any).notes,
                          job_salary: (job as any).salary_range || (job as any).salary || (job as any).compensation,
                        }),
                      });

                      // Stream the response
                      const reader = resp.body?.getReader();
                      if (!reader) throw new Error('No response body');
                      const decoder = new TextDecoder();
                      let textBuffer = '';
                      let resultSoFar = '';

                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        textBuffer += decoder.decode(value, { stream: true });
                        const lines = textBuffer.split('\n');
                        textBuffer = lines.pop() || '';
                        for (const line of lines) {
                          if (line.startsWith('data: ')) {
                            try {
                              const data = JSON.parse(line.slice(6));
                              if (data.error) throw new Error(data.error);
                              if (data.content) {
                                resultSoFar += data.content;
                                setMatchResults(resultSoFar);
                              }
                            } catch (e: any) {
                              if (e.message && !e.message.includes('JSON')) throw e;
                            }
                          }
                        }
                      }

                      if (!resultSoFar) setMatchResults('No matches found.');
                    } catch (err: any) {
                      toast.error(err.message || 'Failed to match');
                      setMatchResults('');
                    } finally {
                      setMatching(false);
                    }
                  }}
                  className="gap-1.5"
                >
                  <Sparkles className="h-4 w-4" />
                  Find Matching Candidates
                </Button>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default JobDetail;
