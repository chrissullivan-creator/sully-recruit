import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { TaskSidebar } from '@/components/tasks/TaskSidebar';
import { useCandidate, useNotes, useCandidateConversations, useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin,
  Edit, Briefcase, MessageSquare, History, User, Play,
  FileText, Sparkles, Loader2, Check, X, ExternalLink, RefreshCw,
  DollarSign, ChevronDown, ChevronUp, PhoneCall, MessageCircle, Clock, Volume2, PhoneIncoming, PhoneOutgoing,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { CallDetailModal } from '@/components/shared/CallDetailModal';

const JOB_STATUSES = [
  { value: 'new',          label: 'New',          color: 'bg-slate-500/15 text-slate-400' },
  { value: 'reached_out',  label: 'Reached Out',  color: 'bg-blue-500/15 text-blue-400' },
  { value: 'pitched',      label: 'Pitched',      color: 'bg-indigo-500/15 text-indigo-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'submitted',    label: 'Submitted',    color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',     color: 'bg-muted text-muted-foreground' },
];

const SENTIMENT_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  interested:       { label: 'Interested',       bg: 'bg-[#2A5C42]',    text: 'text-white' },
  positive:         { label: 'Positive',         bg: 'bg-green-500/15', text: 'text-green-500' },
  maybe:            { label: 'Maybe',            bg: 'bg-[#C9A84C]/15', text: 'text-[#C9A84C]' },
  neutral:          { label: 'Neutral',          bg: 'bg-gray-500/15',  text: 'text-gray-400' },
  negative:         { label: 'Negative',         bg: 'bg-orange-500/15', text: 'text-orange-500' },
  not_interested:   { label: 'Not Interested',   bg: 'bg-red-500/15',   text: 'text-red-500' },
  do_not_contact:   { label: 'Do Not Contact',   bg: 'bg-red-900/20',   text: 'text-red-700' },
};

const SentimentChip = ({ sentiment, note }: { sentiment?: string | null; note?: string | null }) => {
  if (!sentiment) return null;
  const cfg = SENTIMENT_CONFIG[sentiment] ?? { label: sentiment.replace(/_/g, ' '), bg: 'bg-muted', text: 'text-muted-foreground' };
  return (
    <div>
      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', cfg.bg, cfg.text)}>
        {cfg.label}
      </span>
      {note && <p className="text-[10px] italic text-muted-foreground mt-0.5 line-clamp-2">{note}</p>}
    </div>
  );
};

const ChannelIcon = ({ channel }: { channel?: string | null }) => {
  if (!channel) return null;
  if (channel === 'email') return <Mail className="h-3 w-3" />;
  if (channel === 'linkedin' || channel.startsWith('linkedin')) return <Linkedin className="h-3 w-3" />;
  if (channel === 'sms') return <MessageCircle className="h-3 w-3" />;
  if (channel === 'phone') return <PhoneCall className="h-3 w-3" />;
  return null;
};

const EditableField = ({ label, value, onSave, type = 'text', placeholder }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); setEditing(false); };
  const cancel = () => { setDraft(value ?? ''); setEditing(false); };
  return (
    <div className="group space-y-0.5">
      <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input ref={inputRef} type={type} value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
            className="h-7 text-sm flex-1" placeholder={placeholder} />
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-green-400" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancel}>
            <X className="h-3 w-3 text-red-400" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 hover:bg-accent/10 transition-colors" onClick={() => setEditing(true)}>
          <span className={cn('text-sm flex-1 truncate', value ? 'text-foreground' : 'text-muted-foreground italic')}>
            {value || placeholder || '—'}
          </span>
          <Edit className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
        </div>
      )}
    </div>
  );
};

const EditableTextarea = ({ label, value, onSave, placeholder, rows = 4 }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  placeholder?: string; rows?: number;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); setEditing(false); };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-[10px] text-muted-foreground hover:text-accent flex items-center gap-0.5">
            <Edit className="h-2.5 w-2.5" /> Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={rows}
            className="w-full rounded-md border border-input bg-background text-foreground p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            placeholder={placeholder} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="gold" onClick={save} disabled={saving} className="h-7 text-xs">
              {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setDraft(value ?? ''); setEditing(false); }} className="h-7 text-xs">Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-foreground rounded-md border border-transparent hover:border-border cursor-pointer p-1.5 -mx-1.5 min-h-8 whitespace-pre-wrap" onClick={() => setEditing(true)}>
          {value || <span className="text-muted-foreground italic">{placeholder || 'Click to add…'}</span>}
        </div>
      )}
    </div>
  );
};

const CandidateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: candidate, isLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const { data: profiles = [] } = useProfiles();
  const openJobs = (jobs as any[]).filter(j => ['lead','hot','offer_made'].includes(j.status));
  const { data: notes = [] } = useNotes(id, 'candidate');
  const { data: conversations = [] } = useCandidateConversations(id);
  const { data: callNotes = [] } = useQuery({
    queryKey: ['ai_call_notes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_call_notes')
        .select('*')
        .eq('candidate_id', id!)
        .order('updated_candidates_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as any[];
    },
  });
  const { data: callLogs = [] } = useQuery({
    queryKey: ['call_logs', 'candidate', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('call_logs')
        .select('*')
        .eq('candidate_id', id!)
        .order('started_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });
  const [selectedCall, setSelectedCall] = useState<any>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [updatingJobStatus, setUpdatingJobStatus] = useState(false);
  const [generatingJoe, setGeneratingJoe] = useState(false);
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [compExpanded, setCompExpanded] = useState(false);

  useEffect(() => {
    if (!id) return;
    supabase.from('resumes').select('file_path, created_at').eq('candidate_id', id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        if (data?.file_path) {
          const { data: urlData } = supabase.storage.from('resumes').getPublicUrl(data.file_path);
          setResumeUrl(urlData?.publicUrl ?? null);
        }
      });
  }, [id]);

  useEffect(() => {
    if (!resumeUrl && candidate?.resume_url) setResumeUrl(candidate.resume_url);
  }, [candidate?.resume_url]);

  const updateField = async (field: string, value: string) => {
    if (!id) return;
    const updates: any = { [field]: value || null };

    // Auto-compute full_name when first_name or last_name changes
    if (field === 'first_name' || field === 'last_name') {
      const first = field === 'first_name' ? value : candidate?.first_name || '';
      const last = field === 'last_name' ? value : candidate?.last_name || '';
      updates.full_name = `${first} ${last}`.trim() || null;
    }

    const { error } = await supabase.from('candidates').update(updates).eq('id', id);
    if (error) { toast.error(`Failed to update`); return; }
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    queryClient.invalidateQueries({ queryKey: ['candidates'] });
  };

  const updateComp = async (field: string, value: string) => {
    if (!id) return;
    const num = value ? parseFloat(value.replace(/[^0-9.]/g, '')) : null;
    const updates: any = { [field]: isNaN(num as number) ? null : num };

    // Auto-move to "back_of_resume" when compensation is entered and status is "new"
    if (num && !isNaN(num) && candidate?.status === 'new') {
      updates.status = 'back_of_resume';
      toast.success('Compensation added — status moved to Back of Resume');
    }

    await supabase.from('candidates').update(updates).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    queryClient.invalidateQueries({ queryKey: ['candidates'] });
  };

  const updateJobStatus = async (newStatus: string) => {
    if (!id) return;
    setUpdatingJobStatus(true);
    await supabase.from('candidates').update({ job_status: newStatus }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    setUpdatingJobStatus(false);
  };

  const generateJoeSays = async () => {
    if (!id) return;
    setGeneratingJoe(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-joe-says`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ candidate_id: id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      toast.success('Joe Says updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate');
    } finally {
      setGeneratingJoe(false);
    }
  };

  const handleSaveNote = async () => {
    if (!noteText.trim() || !id) return;
    setSavingNote(true);
    const { error } = await supabase.from('notes').insert({ entity_id: id, entity_type: 'candidate', note: noteText.trim() });
    if (error) toast.error('Failed to save note');
    else { toast.success('Note saved'); setNoteText(''); queryClient.invalidateQueries({ queryKey: ['notes', 'candidate', id] }); }
    setSavingNote(false);
  };

  if (isLoading) return <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></MainLayout>;
  if (!candidate) return <MainLayout><div className="flex items-center justify-center h-full"><p className="text-muted-foreground">Candidate not found.</p></div></MainLayout>;

  const initials = `${candidate.first_name?.[0] ?? ''}${candidate.last_name?.[0] ?? ''}`;
  const fullName = candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`;
  const c = candidate as any;

  return (
    <MainLayout>
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/candidates')}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">{fullName}</h1>
          <p className="text-sm text-muted-foreground">{candidate.current_title ?? ''}{candidate.current_title && candidate.current_company ? ' at ' : ''}{candidate.current_company ?? ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {resumeUrl && (
            <Button variant="outline" size="sm" onClick={() => setShowResume(!showResume)}>
              <FileText className="h-3.5 w-3.5 mr-1" />{showResume ? 'Hide Resume' : 'View Resume'}
            </Button>
          )}
          <Button variant="gold" size="sm" onClick={() => navigate(`/candidates/${id}/sendout`)}>
            <FileText className="h-3.5 w-3.5 mr-1" />Send Out
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
            <Play className="h-3.5 w-3.5 mr-1" />Enroll in Sequence
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            const tabsList = document.querySelector('[data-value="joe"]') as HTMLElement;
            if (tabsList) tabsList.click();
          }}>
            <Sparkles className="h-3.5 w-3.5 mr-1" />Ask Joe ✍️
          </Button>
          <Button variant="outline" size="sm" onClick={async () => {
            toast.info('Syncing activity across all channels...');
            try {
              const backendUrl = import.meta.env.REACT_APP_BACKEND_URL || '';
              const resp = await fetch(`${backendUrl}/api/sync-activity-timestamps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_type: 'candidate', entity_id: id }),
              });
              const data = await resp.json();
              if (data.error) throw new Error(data.error);
              toast.success(`Synced: ${data.messages_scanned} messages, ${data.calls_scanned} calls scanned`);
              queryClient.invalidateQueries({ queryKey: ['candidate', id] });
            } catch (err: any) {
              toast.error(err.message || 'Sync failed');
            }
          }}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />Sync Activity
          </Button>
        </div>
      </div>

      {showResume && resumeUrl && (
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-8 py-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium">Resume</span>
              <a href={resumeUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline flex items-center gap-1">
                Open in new tab <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowResume(false)}><X className="h-3.5 w-3.5" /></Button>
          </div>
          <iframe src={resumeUrl} className="w-full h-[500px]" title="Resume" />
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-5 space-y-5">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent mb-2">{initials}</div>
              <Badge variant="secondary" className="text-xs">{candidate.status === 'back_of_resume' ? 'Back of Resume' : candidate.status === 'reached_out' ? 'Reached Out' : candidate.status?.charAt(0).toUpperCase() + candidate.status?.slice(1)}</Badge>
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Contact</h3>
              <EditableField label="Email" value={candidate.email} onSave={v => updateField('email', v)} type="email" placeholder="email@domain.com" />
              <EditableField label="Phone" value={candidate.phone} onSave={v => updateField('phone', v)} placeholder="+1 (555) 000-0000" />
              <EditableField label="LinkedIn" value={candidate.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/in/..." />
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1"><Clock className="h-3 w-3" /> Last Activity</h3>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last Reached Out</span>
                  <span className="text-foreground">{c.last_contacted_at ? format(new Date(c.last_contacted_at), 'MMM d, yyyy') : '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last Response</span>
                  <span className="text-foreground">{c.last_responded_at ? format(new Date(c.last_responded_at), 'MMM d, yyyy') : '—'}</span>
                </div>
                {c.last_comm_channel && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Channel</span>
                    <span className="inline-flex items-center gap-1 text-foreground capitalize">
                      <ChannelIcon channel={c.last_comm_channel} />
                      {c.last_comm_channel === 'linkedin' ? 'LinkedIn' : c.last_comm_channel}
                    </span>
                  </div>
                )}
              </div>
              <SentimentChip sentiment={c.last_sequence_sentiment} note={c.last_sequence_sentiment_note} />
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Current Role</h3>
              <EditableField label="First Name" value={candidate.first_name} onSave={v => updateField('first_name', v)} />
              <EditableField label="Last Name" value={candidate.last_name} onSave={v => updateField('last_name', v)} />
              <EditableField label="Title" value={candidate.current_title} onSave={v => updateField('current_title', v)} placeholder="e.g. VP, Risk" />
              <EditableField label="Company" value={candidate.current_company} onSave={v => updateField('current_company', v)} placeholder="Firm name" />
              <EditableField label="Location" value={c.location_text} onSave={v => updateField('location_text', v)} placeholder="City, State" />
            </div>

            <div className="space-y-2">
              <button className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest w-full" onClick={() => setCompExpanded(!compExpanded)}>
                <DollarSign className="h-3 w-3" /> Compensation
                {compExpanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {compExpanded && (
                <div className="space-y-2 pl-1">
                  <EditableField label="Current Base" value={c.current_base_comp?.toString()} onSave={v => updateComp('current_base_comp', v)} placeholder="e.g. 200000" />
                  <EditableField label="Current Bonus" value={c.current_bonus_comp?.toString()} onSave={v => updateComp('current_bonus_comp', v)} placeholder="e.g. 150000" />
                  <EditableField label="Current Total" value={c.current_total_comp?.toString()} onSave={v => updateComp('current_total_comp', v)} placeholder="e.g. 350000" />
                  <EditableField label="Target Base" value={c.target_base_comp?.toString()} onSave={v => updateComp('target_base_comp', v)} placeholder="e.g. 250000" />
                  <EditableField label="Target Total" value={c.target_total_comp?.toString()} onSave={v => updateComp('target_total_comp', v)} placeholder="e.g. 400000" />
                  <EditableField label="Comp Notes" value={c.comp_notes} onSave={v => updateField('comp_notes', v)} placeholder="Deferred comp, RSUs, etc." />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Preferences</h3>
              <EditableField label="Work Auth" value={c.work_authorization} onSave={v => updateField('work_authorization', v)} placeholder="Citizen, GC, H1-B..." />
              <EditableField label="Relocation" value={c.relocation_preference} onSave={v => updateField('relocation_preference', v)} placeholder="Open, No, NYC only..." />
              <EditableField label="Target Locations" value={c.target_locations} onSave={v => updateField('target_locations', v)} placeholder="NYC, Chicago..." />
              <EditableField label="Target Roles" value={c.target_roles} onSave={v => updateField('target_roles', v)} placeholder="PM, Quant, Tech..." />
              <EditableField label="Reason for Leaving" value={c.reason_for_leaving} onSave={v => updateField('reason_for_leaving', v)} placeholder="Comp, culture, layoff..." />
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Owner</h3>
              <Select value={candidate.owner_id ?? 'none'} onValueChange={async (val) => {
                const newOwnerId = val === 'none' ? null : val;
                await supabase.from('candidates').update({ owner_id: newOwnerId }).eq('id', id!);
                queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                queryClient.invalidateQueries({ queryKey: ['candidates'] });
                toast.success(newOwnerId ? 'Owner updated' : 'Owner removed');
              }}>
                <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Assign owner…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Unassigned —</SelectItem>
                  {profiles.filter(p => p.full_name).map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Active Job</h3>
              <Select value={candidate.job_id ?? 'none'} onValueChange={async (val) => {
                const newJobId = val === 'none' ? null : val;
                await supabase.from('candidates').update({ job_id: newJobId, job_status: newJobId ? 'new' : null }).eq('id', id!);
                queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                queryClient.invalidateQueries({ queryKey: ['candidates'] });
                toast.success(newJobId ? 'Job assigned' : 'Job removed');
              }}>
                <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Assign a job…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {openJobs.map((j: any) => <SelectItem key={j.id} value={j.id}>{j.title}{j.companies?.name ? ` — ${j.companies.name}` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
              {candidate.job_id && (
                <Select value={c.job_status ?? ''} onValueChange={updateJobStatus} disabled={updatingJobStatus}>
                  <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Set status…" /></SelectTrigger>
                  <SelectContent>
                    {JOB_STATUSES.map(s => (
                      <SelectItem key={s.value} value={s.value}>
                        <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>{s.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground">Added {format(new Date(candidate.created_at), 'MMM d, yyyy')}</p>
          </div>
        </aside>

        <div className="flex-1 flex flex-col overflow-hidden">
          <Tabs defaultValue="joe" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-4 border-b border-border">
              <TabsList className="bg-secondary">
                <TabsTrigger value="joe" className="gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Joe Says</TabsTrigger>
                <TabsTrigger value="background" className="gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Background</TabsTrigger>
                <TabsTrigger value="communications" className="gap-1.5"><MessageSquare className="h-3.5 w-3.5" /> Communications</TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5"><User className="h-3.5 w-3.5" /> Notes</TabsTrigger>
                <TabsTrigger value="call-notes" className="gap-1.5"><PhoneCall className="h-3.5 w-3.5" /> Calls</TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5"><History className="h-3.5 w-3.5" /> Activity</TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              <TabsContent value="joe" className="px-8 py-5 mt-0">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-accent" />
                    <h2 className="text-base font-semibold">Joe Says</h2>
                    {c.joe_says_updated_at && (
                      <span className="text-xs text-muted-foreground">Updated {format(new Date(c.joe_says_updated_at), 'MMM d, h:mm a')}</span>
                    )}
                  </div>
                  <Button variant="gold-outline" size="sm" onClick={generateJoeSays} disabled={generatingJoe}>
                    {generatingJoe ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                    {c.joe_says ? 'Regenerate' : 'Generate Joe Says'}
                  </Button>
                </div>

                {generatingJoe ? (
                  <div className="flex items-center gap-3 py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Joe is analyzing this candidate...</span>
                  </div>
                ) : c.joe_says ? (
                  <div className="rounded-xl border border-accent/20 bg-accent/5 p-5 space-y-1">
                    {(c.joe_says as string).split('\n').map((line: string, i: number) => (
                      line.trim() ? (
                        <p key={i} className="text-sm leading-relaxed text-foreground">{line}</p>
                      ) : <div key={i} className="h-1" />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No Joe Says yet</p>
                    <p className="text-xs text-muted-foreground mb-4">AI brief using resume, notes, communications, and sequence history.</p>
                    <Button variant="gold" size="sm" onClick={generateJoeSays}>
                      <Sparkles className="h-3.5 w-3.5 mr-1" /> Generate Joe Says
                    </Button>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="background" className="px-8 py-5 mt-0 space-y-6">
                <EditableTextarea label="Candidate Summary" value={c.candidate_summary} onSave={v => updateField('candidate_summary', v)} placeholder="General background and career overview..." rows={5} />
                <EditableTextarea label="Back of Resume Notes" value={c.back_of_resume_notes} onSave={v => updateField('back_of_resume_notes', v)} placeholder="Products, business lines, divisions, function, motivations from phone screen..." rows={6} />
                <EditableTextarea label="Reason for Leaving / Job Change History" value={c.reason_for_leaving} onSave={v => updateField('reason_for_leaving', v)} placeholder="Why they're looking and pattern of moves..." rows={3} />
              </TabsContent>

              <TabsContent value="communications" className="px-8 py-5 mt-0">
                <div className="flex items-center gap-2 mb-5">
                  <Button variant="outline" size="sm"><Mail className="h-3.5 w-3.5 mr-1" /> Email</Button>
                  <Button variant="outline" size="sm"><Phone className="h-3.5 w-3.5 mr-1" /> Call</Button>
                  <Button variant="outline" size="sm"><Linkedin className="h-3.5 w-3.5 mr-1" /> LinkedIn</Button>
                  <Button variant="outline" size="sm"><MessageSquare className="h-3.5 w-3.5 mr-1" /> SMS</Button>
                </div>
                {(conversations as any[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No communications yet.</p>
                ) : (
                  <div className="space-y-3">
                    {(conversations as any[]).map((conv) => (
                      <div key={conv.id} className="rounded-lg border border-border p-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-sm font-medium capitalize">{conv.channel}</span>
                          <span className="text-xs text-muted-foreground">{conv.last_message_at ? format(new Date(conv.last_message_at), 'MMM d, yyyy') : ''}</span>
                        </div>
                        {conv.subject && <p className="text-sm mb-0.5">{conv.subject}</p>}
                        {conv.last_message_preview && <p className="text-xs text-muted-foreground">{conv.last_message_preview}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="notes" className="px-8 py-5 mt-0 space-y-4">
                <textarea placeholder="Add a note..." value={noteText} onChange={e => setNoteText(e.target.value)}
                  className="w-full h-24 rounded-lg border border-input bg-background text-foreground p-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
                <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={savingNote || !noteText.trim()}>
                  {savingNote && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />} Save Note
                </Button>
                {(notes as any[]).length > 0 ? (
                  <div className="space-y-3">
                    {(notes as any[]).map((n) => (
                      <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-4">
                        <p className="text-sm whitespace-pre-wrap">{n.note}</p>
                        <p className="text-xs text-muted-foreground mt-2">{format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}</p>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted-foreground">No notes yet.</p>}
              </TabsContent>

              <TabsContent value="call-notes" className="px-8 py-5 mt-0">
                <div className="flex items-center gap-2 mb-5">
                  <PhoneCall className="h-5 w-5 text-accent" />
                  <h2 className="text-base font-semibold">Calls</h2>
                  <span className="text-xs text-muted-foreground">({(callLogs as any[]).length} calls, {(callNotes as any[]).length} with AI notes)</span>
                </div>
                {(callLogs as any[]).length === 0 && (callNotes as any[]).length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <PhoneCall className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No calls yet</p>
                    <p className="text-xs text-muted-foreground">Call logs and AI-extracted notes will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Show call_logs first — they have the timeline */}
                    {(callLogs as any[]).map((call: any) => {
                      const isOut = call.direction === 'outbound';
                      const dur = call.duration_seconds;
                      const durStr = dur ? `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}` : '--:--';
                      const aiNote = (callNotes as any[]).find((n: any) => n.call_log_id === call.id || n.external_call_id === call.external_call_id);
                      const summaryPreview = aiNote?.ai_summary || call.summary || call.notes || '';
                      return (
                        <button
                          key={call.id}
                          onClick={() => setSelectedCall({ call, aiNote })}
                          className="w-full text-left rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-all"
                        >
                          <div className="flex items-center gap-3">
                            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', isOut ? 'bg-info/10 text-info' : 'bg-success/10 text-success')}>
                              {isOut ? <PhoneOutgoing className="h-4 w-4" /> : <PhoneIncoming className="h-4 w-4" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">{isOut ? 'Outbound' : 'Inbound'} Call</span>
                                <span className="text-xs text-muted-foreground">{call.phone_number}</span>
                                {call.audio_url && <Volume2 className="h-3 w-3 text-accent shrink-0" />}
                                {aiNote && <Badge variant="secondary" className="text-[9px]">AI Notes</Badge>}
                              </div>
                              {summaryPreview && (
                                <p className="text-xs text-muted-foreground truncate mt-0.5 max-w-lg">{summaryPreview.slice(0, 120)}{summaryPreview.length > 120 ? '...' : ''}</p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-xs text-muted-foreground">{call.started_at ? format(new Date(call.started_at), 'MMM d, h:mm a') : '—'}</p>
                              <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end"><Clock className="h-3 w-3" /> {durStr}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                    {/* Show orphan AI notes (no matching call_log) */}
                    {(callNotes as any[]).filter((n: any) => !(callLogs as any[]).some((cl: any) => cl.id === n.call_log_id || (cl.external_call_id && cl.external_call_id === n.external_call_id))).map((note: any, idx: number) => (
                      <button
                        key={note.id ?? idx}
                        onClick={() => setSelectedCall({ call: { id: note.id, direction: note.call_direction || 'outbound', phone_number: note.phone_number || '', duration_seconds: note.call_duration_seconds, started_at: note.call_started_at || note.created_at, audio_url: note.recording_url, summary: note.ai_summary, notes: note.extracted_notes, linked_entity_name: c.full_name }, aiNote: note })}
                        className="w-full text-left rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                            <PhoneCall className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">Call Notes</span>
                              {note.recording_url && <Volume2 className="h-3 w-3 text-accent shrink-0" />}
                              <Badge variant="secondary" className="text-[9px]">AI Notes</Badge>
                            </div>
                            {note.ai_summary && <p className="text-xs text-muted-foreground truncate mt-0.5 max-w-lg">{note.ai_summary.slice(0, 120)}...</p>}
                          </div>
                          <p className="text-xs text-muted-foreground shrink-0">{note.call_started_at ? format(new Date(note.call_started_at), 'MMM d, h:mm a') : note.created_at ? format(new Date(note.created_at), 'MMM d') : '—'}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <CallDetailModal
                  open={!!selectedCall}
                  onOpenChange={(v) => !v && setSelectedCall(null)}
                  call={selectedCall?.call}
                  aiNotes={selectedCall?.aiNote}
                />
              </TabsContent>

              <TabsContent value="activity" className="px-8 py-5 mt-0">
                <p className="text-sm text-muted-foreground">Activity history will appear here.</p>
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>

        {id && (
          <div className="w-72 shrink-0 border-l border-border p-4 overflow-y-auto">
            <TaskSidebar entityType="candidate" entityId={id} />
          </div>
        )}
      </div>

      <EnrollInSequenceDialog open={enrollOpen} onOpenChange={setEnrollOpen} candidateIds={id ? [id] : []} candidateNames={[fullName]} />
    </MainLayout>
  );
};

export default CandidateDetail;
