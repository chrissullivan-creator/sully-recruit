import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { useCandidate, useNotes, useCandidateConversations, useJobs } from '@/hooks/useData';
import { useAuth } from '@/contexts/AuthContext';
import { useProfiles } from '@/hooks/useProfiles';
import { useEntityTasks, Task } from '@/hooks/useTasks';
import { TaskCard } from '@/components/tasks/TaskCard';
import { EditMeetingDialog } from '@/components/tasks/EditMeetingDialog';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin,
  Edit, Briefcase, MessageSquare, History, User, Play,
  FileText, Sparkles, Loader2, Check, X, ExternalLink, RefreshCw,
  DollarSign, ChevronDown, ChevronUp, PhoneCall, MessageCircle, Clock, Volume2, PhoneIncoming, PhoneOutgoing,
  GraduationCap, Upload, Plus, Info, FolderOpen, Trash2, Send, Martini,
  Search, Calendar, Merge, CalendarPlus,
} from 'lucide-react';
import { EntityNotesTab } from '@/components/shared/EntityNotesTab';
import { ScheduleMeetingDialog } from '@/components/calendar/ScheduleMeetingDialog';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/shared/SearchableSelect';
import { cn } from '@/lib/utils';
import { CANONICAL_PIPELINE, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';
import { format } from 'date-fns';
import { CallDetailModal } from '@/components/shared/CallDetailModal';
import { MergeCandidateDialog } from '@/components/candidates/MergeCandidateDialog';
import { ensureInterviewArtifacts } from '@/lib/interviewWorkflow';
import {
  invalidatePersonScope, invalidateSendOutScope, invalidateNoteScope,
  invalidateTaskScope,
} from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';

// Pipeline chip strip — derives from the canonical pipeline
// (frontend/src/lib/pipeline.ts) so this UI never drifts from the
// dashboard / Send Outs page. Canonical values: pitch, ready_to_send
// ('Send Out'), submitted ('Submission'), interview, offer, placed,
// withdrawn. Legacy values (sent / interviewing / rejected / new /
// reached_out) get normalised through stageToCanonical when reading
// existing rows; writes go in the canonical form.
const SEND_OUT_STAGES = CANONICAL_PIPELINE.map((s) => ({
  value: s.key,
  label: s.label,
  color: s.color,
}));

const REJECTED_BY_OPTIONS = [
  { value: 'recruiter',    label: 'By Recruiter' },
  { value: 'sales_person', label: 'By Sales Person' },
  { value: 'client',       label: 'By Client' },
  { value: 'candidate',    label: 'By Candidate' },
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

const EditableField = ({ label, value, onSave, type = 'text', placeholder, disabled = false, highlight = false }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string; disabled?: boolean; highlight?: boolean;
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
        <div className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 -mx-1.5 transition-colors", disabled ? '' : 'cursor-pointer hover:bg-accent/10', highlight && !disabled && 'bg-accent/5 ring-1 ring-accent/20')} onClick={() => !disabled && setEditing(true)}>
          <span className={cn('text-sm flex-1 truncate', value ? 'text-foreground' : 'text-muted-foreground italic')}>
            {value || placeholder || '—'}
          </span>
          {!disabled && <Edit className={cn("h-3 w-3 text-muted-foreground shrink-0", highlight ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100')} />}
        </div>
      )}
    </div>
  );
};

const EditableTextarea = ({ label, value, onSave, placeholder, rows = 4, disabled = false }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  placeholder?: string; rows?: number; disabled?: boolean;
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
        {!editing && !disabled && (
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
        <div className={cn("text-sm text-foreground rounded-md border border-transparent p-1.5 -mx-1.5 min-h-8 whitespace-pre-wrap", disabled ? '' : 'hover:border-border cursor-pointer')} onClick={() => !disabled && setEditing(true)}>
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
  const { user, session } = useAuth();
  const { data: candidate, isLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const { data: profiles = [] } = useProfiles();
  const openJobs = (jobs as any[]).filter(j => !['closed_lost','closed_won','lost','closed'].includes(j.status));
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
  const [scheduleMeetingOpen, setScheduleMeetingOpen] = useState(false);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [compExpanded, setCompExpanded] = useState(false);
  const [workHistoryOpen, setWorkHistoryOpen] = useState(false);
  const [educationOpen, setEducationOpen] = useState(false);
  const [showAddWork, setShowAddWork] = useState(false);
  const [showAddEducation, setShowAddEducation] = useState(false);
  const [savingWork, setSavingWork] = useState(false);
  const [savingEducation, setSavingEducation] = useState(false);
  const [workForm, setWorkForm] = useState({ company_name: '', title: '', start_date: '', end_date: '', is_current: false, description: '' });
  const [eduForm, setEduForm] = useState({ institution: '', degree: '', field_of_study: '', start_year: '', end_year: '' });
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState('joe');
  const [sidebarTab, setSidebarTab] = useState<'all' | 'notes' | 'tasks' | 'meetings'>('all');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);

  const handleDeleteCandidate = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      const { error } = await softDelete('people', id);
      if (error) { toast.error(error.message || 'Failed to delete candidate'); return; }
      toast.success('Moved to trash — undo from /audit/trash within 30 days');
      invalidatePersonScope(queryClient);
      navigate('/candidates');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete candidate');
    } finally {
      setDeleting(false);
    }
  };

  // Ask Joe chat state
  const [joeChatMessages, setJoeChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [joeChatInput, setJoeChatInput] = useState('');
  const [joeChatLoading, setJoeChatLoading] = useState(false);
  const joeChatScrollRef = useRef<HTMLDivElement>(null);

  const { data: workHistory = [] } = useQuery({
    queryKey: ['candidate_work_history', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_work_history')
        .select('*')
        .eq('candidate_id', id!)
        .order('start_date', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: education = [] } = useQuery({
    queryKey: ['candidate_education', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_education')
        .select('*')
        .eq('candidate_id', id!)
        .order('start_year', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: candidateResumes = [] } = useQuery({
    queryKey: ['resumes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('resumes')
        .select('*')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: formattedResumes = [] } = useQuery({
    queryKey: ['formatted_resumes', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('formatted_resumes')
        .select('*')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const [uploadingFormatted, setUploadingFormatted] = useState(false);
  const [uploadingOtherDoc, setUploadingOtherDoc] = useState(false);
  const [docFolder, setDocFolder] = useState<'resumes' | 'formatted' | 'other'>('resumes');
  const [editingInfo, setEditingInfo] = useState(false);
  const otherDocInputRef = useRef<HTMLInputElement>(null);

  // Send Out management state
  const [addingSendOut, setAddingSendOut] = useState(false);
  const [selectedJobForSendOut, setSelectedJobForSendOut] = useState<string>('');
  const [savingSendOut, setSavingSendOut] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectForm, setRejectForm] = useState({ rejected_by: '', rejection_reason: '', feedback: '' });

  // Permission checks
  const currentProfile = profiles.find(p => p.id === user?.id);
  const isAdmin = !!(currentProfile as any)?.is_admin;
  const isOwner = !!(user && candidate && (candidate as any).owner_user_id === user.id);
  const canEdit = isOwner || isAdmin;
  const [pendingOwnerId, setPendingOwnerId] = useState<string | null>(null);
  const pendingOwnerName = pendingOwnerId ? profiles.find(p => p.id === pendingOwnerId)?.full_name ?? 'this user' : '';

  // Match score for candidate's assigned job
  const { data: candidateJobMatch } = useQuery({
    queryKey: ['candidate_job_match', id, candidate?.job_id],
    enabled: !!id && !!(candidate as any)?.job_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('job_candidate_matches')
        .select('overall_score, tier, reasoning, strengths, concerns')
        .eq('candidate_id', id!)
        .eq('job_id', (candidate as any).job_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  const handleFormattedUpload = async (file: File, versionLabel: string) => {
    if (!id) return;
    setUploadingFormatted(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `${session.user.id}/${id}/formatted/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase.from('formatted_resumes').insert({
        candidate_id: id,
        file_name: file.name,
        file_path: path,
        mime_type: file.type || 'application/pdf',
        file_size: file.size,
        version_label: versionLabel || 'v1',
        created_by: session.user.id,
      } as any);
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ['formatted_resumes', id] });
      toast.success('Formatted resume uploaded');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploadingFormatted(false);
    }
  };

  const { data: otherDocs = [] } = useQuery({
    queryKey: ['candidate_documents', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_documents')
        .select('*')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const handleOtherDocUpload = async (file: File) => {
    if (!id) return;
    setUploadingOtherDoc(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `${session.user.id}/${id}/other/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase.from('candidate_documents').insert({
        candidate_id: id,
        file_name: file.name,
        file_path: path,
        mime_type: file.type || 'application/octet-stream',
        file_size: file.size,
        created_by: session.user.id,
      } as any);
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ['candidate_documents', id] });
      toast.success('Document uploaded');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploadingOtherDoc(false);
    }
  };

  const handleDeleteDocument = async (table: 'resumes' | 'formatted_resumes' | 'candidate_documents', docId: string, filePath: string | null) => {
    try {
      if (filePath) {
        await supabase.storage.from('resumes').remove([filePath]);
      }
      const { error } = await supabase.from(table).delete().eq('id', docId);
      if (error) throw error;
      const qk = table === 'resumes' ? ['resumes', id] : table === 'formatted_resumes' ? ['formatted_resumes', id] : ['candidate_documents', id];
      queryClient.invalidateQueries({ queryKey: qk });
      toast.success('Document deleted');
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete document');
    }
  };

  // Tasks & meetings linked to this candidate
  const { data: candidateTasks = [] } = useEntityTasks('candidate', id);
  const regularTasks = candidateTasks.filter((t: Task) => t.task_type !== 'meeting');
  const meetings = candidateTasks.filter((t: Task) => t.task_type === 'meeting');
  const [editingMeeting, setEditingMeeting] = useState<Task | null>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);

  const { data: sendOuts = [] } = useQuery({
    queryKey: ['candidate_send_outs', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select('*, jobs(id, title, company_name, location, status)')
        .eq('candidate_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const handleAddSendOut = async () => {
    if (!id || !selectedJobForSendOut) return;
    setSavingSendOut(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { error } = await supabase.from('send_outs').insert({
        candidate_id: id,
        job_id: selectedJobForSendOut,
        // 'pitch' is the canonical first stage — candidate has been added
        // to the pipeline and now needs to be pitched the role.
        stage: 'pitch',
        recruiter_id: session?.user?.id ?? null,
      } as any);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
      setSelectedJobForSendOut('');
      setAddingSendOut(false);
      toast.success('Candidate added to job pipeline');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingSendOut(false);
    }
  };

  const handleUpdateStage = async (sendOutId: string, newStage: string) => {
    // Canonical pipeline keys: pitch | ready_to_send | submitted | interview |
    // offer | placed | withdrawn. Map any legacy values that may still arrive.
    const canonical = stageToCanonical(newStage) ?? (newStage as CanonicalStage);
    const updates: any = { stage: canonical, updated_at: new Date().toISOString() };
    if (canonical === 'submitted') updates.sent_to_client_at = new Date().toISOString();
    if (canonical === 'interview') updates.interview_at = new Date().toISOString();
    if (canonical === 'offer') updates.offer_at = new Date().toISOString();
    if (canonical === 'placed') updates.placed_at = new Date().toISOString();

    const { data: updatedSendOut, error } = await supabase
      .from('send_outs')
      .update(updates)
      .eq('id', sendOutId)
      .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
      .single();
    if (error) { toast.error('Failed to update stage'); return; }

    if (canonical === 'interview' && updatedSendOut) {
      await ensureInterviewArtifacts({
        sendOutId: updatedSendOut.id,
        candidateId: updatedSendOut.candidate_id,
        contactId: updatedSendOut.contact_id,
        jobId: updatedSendOut.job_id,
        recruiterId: updatedSendOut.recruiter_id,
        stage: canonical,
        interviewAt: updatedSendOut.interview_at,
      });
    }

    queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
    toast.success(`Stage updated to ${canonicalConfig(canonical).label}`);
  };

  const handleReject = async (sendOutId: string) => {
    if (!rejectForm.rejected_by) { toast.error('Please select who rejected'); return; }
    const { error } = await supabase.from('send_outs').update({
      stage: 'withdrawn',
      rejected_by: rejectForm.rejected_by,
      rejection_reason: rejectForm.rejection_reason || null,
      feedback: rejectForm.feedback || null,
      updated_at: new Date().toISOString(),
    } as any).eq('id', sendOutId);
    if (error) { toast.error('Failed to reject'); return; }
    queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
    setRejectingId(null);
    setRejectForm({ rejected_by: '', rejection_reason: '', feedback: '' });
    toast.success('Send out rejected');
  };

  const handleDeleteSendOut = async (sendOutId: string) => {
    const { error } = await softDelete('send_outs', sendOutId).then(({ error }) => ({ error: error ? new Error(error.message) : null }));
    if (error) { toast.error('Failed to remove'); return; }
    queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
    toast.success('Removed from pipeline');
  };

  const handleAddWorkHistory = async () => {
    if (!id || !workForm.company_name || !workForm.title) return;
    setSavingWork(true);
    try {
      const { error } = await supabase.from('candidate_work_history').insert({
        candidate_id: id,
        company_name: workForm.company_name,
        title: workForm.title,
        start_date: workForm.start_date || null,
        end_date: workForm.is_current ? null : (workForm.end_date || null),
        is_current: workForm.is_current,
        description: workForm.description || null,
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['candidate_work_history', id] });
      setWorkForm({ company_name: '', title: '', start_date: '', end_date: '', is_current: false, description: '' });
      setShowAddWork(false);
      toast.success('Work experience added');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingWork(false);
    }
  };

  const handleAddEducation = async () => {
    if (!id || !eduForm.institution) return;
    setSavingEducation(true);
    try {
      const { error } = await supabase.from('candidate_education').insert({
        candidate_id: id,
        institution: eduForm.institution,
        degree: eduForm.degree || null,
        field_of_study: eduForm.field_of_study || null,
        start_year: eduForm.start_year ? parseInt(eduForm.start_year) : null,
        end_year: eduForm.end_year ? parseInt(eduForm.end_year) : null,
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['candidate_education', id] });
      setEduForm({ institution: '', degree: '', field_of_study: '', start_year: '', end_year: '' });
      setShowAddEducation(false);
      toast.success('Education added');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingEducation(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!id) return;
    setUploadingFile(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `${session.user.id}/${id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = await supabase.storage.from('resumes').createSignedUrl(path, 3600);
      const { error: dbErr } = await supabase.from('resumes').insert({
        candidate_id: id,
        file_name: file.name,
        file_path: path,
        file_url: urlData?.signedUrl ?? '',
        file_size: file.size,
        mime_type: file.type,
      } as any);
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ['resumes', id] });
      toast.success('File uploaded');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploadingFile(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    supabase.from('resumes').select('file_path, created_at').eq('candidate_id', id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(async ({ data }) => {
        if (data?.file_path) {
          const { data: urlData } = await supabase.storage.from('resumes').createSignedUrl(data.file_path, 3600);
          setResumeUrl(urlData?.signedUrl ?? null);
        }
      });
  }, [id]);

  // Pick a resume to preview. Priority: candidate.resume_url (legacy direct
  // field) > most-recent formatted_resumes row > most-recent resumes row.
  // This way every candidate with a resume on file gets the View Resume
  // button — not just the ones with the legacy column populated.
  useEffect(() => {
    if (resumeUrl) return;
    if (candidate?.resume_url) { setResumeUrl(candidate.resume_url); return; }
    const latestFormatted = (formattedResumes as any[])[0];
    const latest = (candidateResumes as any[])[0];
    const pick = latestFormatted ?? latest;
    if (!pick?.file_path) return;
    const fromMap = signedUrls[pick.file_path];
    if (fromMap) setResumeUrl(fromMap);
  }, [candidate?.resume_url, candidateResumes, formattedResumes, signedUrls, resumeUrl]);

  // Pre-compute signed URLs for all document lists (private bucket)
  useEffect(() => {
    const allDocs = [...candidateResumes, ...formattedResumes, ...otherDocs];
    const paths = allDocs.map((d: any) => d.file_path).filter(Boolean) as string[];
    if (paths.length === 0) return;
    Promise.all(
      paths.map(async (p) => {
        const { data } = await supabase.storage.from('resumes').createSignedUrl(p, 3600);
        return [p, data?.signedUrl ?? null] as const;
      })
    ).then((results) => {
      const map: Record<string, string> = {};
      for (const [path, url] of results) {
        if (url) map[path] = url;
      }
      setSignedUrls(map);
    });
  }, [candidateResumes, formattedResumes, otherDocs]);

  const updateField = async (field: string, value: string) => {
    if (!id) return;
    try {
      const updates: any = { [field]: value || null };

      // Auto-compute full_name when first_name or last_name changes
      if (field === 'first_name' || field === 'last_name') {
        const first = field === 'first_name' ? value : candidate?.first_name || '';
        const last = field === 'last_name' ? value : candidate?.last_name || '';
        updates.full_name = `${first} ${last}`.trim() || null;
      }

      const { error } = await supabase.from('people').update(updates).eq('id', id);
      if (error) { toast.error(`Failed to update ${field.replace(/_/g, ' ')}`); return; }
      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update');
    }
  };

  const updateComp = async (field: string, value: string) => {
    if (!id) return;
    try {
      const num = value ? parseFloat(value.replace(/[^0-9.]/g, '')) : null;
      const updates: any = { [field]: isNaN(num as number) ? null : num };

      // Auto-move to "back_of_resume" when compensation is entered and status is "new"
      if (num && !isNaN(num) && candidate?.status === 'new') {
        updates.status = 'back_of_resume';
        toast.success('Compensation added — status moved to Back of Resume');
      }

      const { error } = await supabase.from('people').update(updates).eq('id', id);
      if (error) { toast.error('Failed to update compensation'); return; }
      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update compensation');
    }
  };

  const updateJobStatus = async (newStatus: string) => {
    if (!id) return;
    setUpdatingJobStatus(true);
    try {
      const normalizedStatus = stageToCanonical(newStatus) ?? (newStatus as CanonicalStage);
      const { error } = await supabase.from('people').update({ job_status: normalizedStatus }).eq('id', id);
      if (error) { toast.error('Failed to update status'); return; }

      if (normalizedStatus === 'interview' && candidate?.job_id) {
        const { data: existingSendOut } = await supabase
          .from('send_outs')
          .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
          .eq('candidate_id', id)
          .eq('job_id', candidate.job_id)
          .maybeSingle();

        const interviewAt = new Date().toISOString();
        let sendOutRecord = existingSendOut;

        if (existingSendOut) {
          const { data: updated } = await supabase
            .from('send_outs')
            .update({ stage: normalizedStatus, interview_at: interviewAt } as any)
            .eq('id', existingSendOut.id)
            .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
            .single();
          sendOutRecord = updated;
        } else {
          const { data: inserted } = await supabase
            .from('send_outs')
            .insert({
              candidate_id: id,
              job_id: candidate.job_id,
              recruiter_id: user?.id ?? null,
              stage: normalizedStatus,
              interview_at: interviewAt,
            } as any)
            .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
            .single();
          sendOutRecord = inserted;
        }

        if (sendOutRecord) {
          await ensureInterviewArtifacts({
            sendOutId: sendOutRecord.id,
            candidateId: sendOutRecord.candidate_id,
            contactId: sendOutRecord.contact_id,
            jobId: sendOutRecord.job_id,
            recruiterId: sendOutRecord.recruiter_id,
            stage: normalizedStatus,
            interviewAt: sendOutRecord.interview_at,
          });
        }
      }

      invalidatePersonScope(queryClient);
      invalidateSendOutScope(queryClient);
      invalidateTaskScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update status');
    } finally {
      setUpdatingJobStatus(false);
    }
  };

  const generateJoeSays = async () => {
    if (!id) return;
    setGeneratingJoe(true);
    try {
      const res = await fetch('/api/trigger-generate-joe-says', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: id, entityType: 'candidate' }),
      });
      const data = await res.json();
      if (!data.triggered) throw new Error(data.error || 'Failed to trigger');
      toast.success('Joe Says generation started — will update shortly');
      // Poll for the update
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      }, 8000);
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      }, 15000);
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

  const handleJoeChatSend = async () => {
    if (!joeChatInput.trim() || joeChatLoading) return;
    const userMsg = { role: 'user' as const, content: joeChatInput };
    const allMessages = [...joeChatMessages, userMsg];
    setJoeChatMessages(allMessages);
    setJoeChatInput('');
    setJoeChatLoading(true);

    // Pre-seed context about this candidate
    const contextMsg = candidate
      ? `[Context: You're discussing candidate ${candidate.full_name || `${candidate.first_name} ${candidate.last_name}`}, ${candidate.current_title || ''} at ${candidate.current_company || ''}. Candidate ID: ${id}]`
      : '';

    let assistantSoFar = '';
    try {
      const apiMessages = [
        ...(contextMsg ? [{ role: 'user', content: contextMsg }, { role: 'assistant', content: 'Got it — I have this candidate pulled up. What do you need?' }] : []),
        ...allMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!resp.ok || !resp.body) throw new Error(`Request failed (${resp.status})`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ') || line.trim() === '') continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.content || parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantSoFar += content;
              const current = assistantSoFar;
              setJoeChatMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && prev.length > allMessages.length) {
                  return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: current } : m));
                }
                return [...prev, { role: 'assistant', content: current }];
              });
            }
          } catch { /* partial JSON — will be completed next chunk */ }
        }
      }
    } catch (err: any) {
      setJoeChatMessages((prev) => [...prev, { role: 'assistant', content: `Something went wrong: ${err.message}` }]);
    } finally {
      setJoeChatLoading(false);
      setTimeout(() => { joeChatScrollRef.current?.scrollTo(0, joeChatScrollRef.current.scrollHeight); }, 50);
    }
  };

  if (isLoading) return <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></MainLayout>;
  if (!candidate) return <MainLayout><div className="flex items-center justify-center h-full"><p className="text-muted-foreground">Candidate not found.</p></div></MainLayout>;

  const initials = `${candidate.first_name?.[0] ?? ''}${candidate.last_name?.[0] ?? ''}`;
  const fullName = candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`;
  const c = candidate as any;

  const filteredNotes = (notes as any[]).filter((n: any) => {
    if (sidebarSearch) {
      const text = (n.note || '').toLowerCase();
      if (!text.includes(sidebarSearch.toLowerCase())) return false;
    }
    return true;
  });

  const filteredCallLogs = (callLogs as any[]).filter((cl: any) => {
    if (sidebarSearch) {
      const text = (cl.summary || cl.notes || '').toLowerCase();
      if (!text.includes(sidebarSearch.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <MainLayout>
      {/* Top header bar — ContactDetail style */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button>
        {c.avatar_url ? (
          <img src={c.avatar_url} alt={fullName} className="h-10 w-10 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent shrink-0">{initials}</div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground truncate">{fullName}</h1>
            <Badge variant="secondary" className="text-xs shrink-0">{candidate.status === 'back_of_resume' ? 'Back of Resume' : candidate.status === 'reached_out' ? 'Reached Out' : candidate.status?.charAt(0).toUpperCase() + candidate.status?.slice(1)}</Badge>
            {(() => {
              const roles: string[] = c.roles ?? ['candidate'];
              return (
                <div className="flex items-center gap-1">
                  {roles.includes('candidate') && (
                    <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium bg-green-500/10 text-green-600 border border-green-500/20">
                      Candidate
                    </span>
                  )}
                  {roles.includes('client') && (
                    <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium bg-[#C9A84C]/10 text-[#C9A84C] border border-[#C9A84C]/20">
                      Client
                    </span>
                  )}
                </div>
              );
            })()}
          </div>
          <p className="text-sm text-muted-foreground truncate">{candidate.current_title ?? ''}{candidate.current_title && candidate.current_company ? ' at ' : ''}{candidate.current_company ?? ''}</p>
        </div>

        {/* Social / contact links */}
        <div className="flex items-center gap-1.5 shrink-0">
          {(() => {
            // Prefer personal_email for candidate outreach (sequences send to
            // personal_email; work_email is shown for context). Fall back to
            // the legacy email column during the migration off it.
            const mailto = (candidate as any).personal_email || (candidate as any).work_email || candidate.email;
            return mailto ? (
              <a href={`mailto:${mailto}`} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={mailto}>
                <Mail className="h-4 w-4" />
              </a>
            ) : null;
          })()}
          {candidate.phone && (
            <a href={`tel:${candidate.phone}`} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={candidate.phone}>
              <Phone className="h-4 w-4" />
            </a>
          )}
          {candidate.linkedin_url && (
            <a href={candidate.linkedin_url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="LinkedIn Profile">
              <Linkedin className="h-4 w-4" />
            </a>
          )}
        </div>

        <div className="flex items-center gap-2">
          {resumeUrl && (
            <Button variant="outline" size="sm" onClick={() => setShowResume(!showResume)}>
              <FileText className="h-3.5 w-3.5 mr-1" />{showResume ? 'Hide Resume' : 'View Resume'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setScheduleMeetingOpen(true)}>
            <CalendarPlus className="h-3.5 w-3.5 mr-1" /> Schedule
          </Button>
          <Button variant="gold" size="sm" onClick={() => navigate(`/candidates/${id}/sendout`)}>
            <FileText className="h-3.5 w-3.5 mr-1" />Send Out
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!id) return;
              const currentRoles: string[] = c.roles ?? ['candidate'];
              const newRoles = currentRoles.includes('client')
                ? currentRoles.filter(r => r !== 'client')
                : [...currentRoles, 'client'];
              await supabase.from('people').update({ roles: newRoles } as any).eq('id', id);
              queryClient.invalidateQueries({ queryKey: ['candidate', id] });
              queryClient.invalidateQueries({ queryKey: ['candidates'] });
              toast.success(newRoles.includes('client') ? 'Tagged as Client' : 'Client tag removed');
            }}
            title={((c.roles ?? ['candidate']) as string[]).includes('client') ? 'Remove Client tag' : 'Tag as Client'}
          >
            {((c.roles ?? ['candidate']) as string[]).includes('client') ? '− Client' : '+ Client'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEnrollOpen(true)}>
            <Play className="h-3.5 w-3.5 mr-1" />Enroll in Sequence
          </Button>
          <Button variant="outline" size="sm" onClick={() => setActiveTab('joe')}>
            <Sparkles className="h-3.5 w-3.5 mr-1" />Ask Joe
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMergeOpen(true)} title="Merge with another candidate">
            <Merge className="h-3.5 w-3.5 mr-1" />Merge
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={deleting} title="Delete candidate">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this candidate?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes {fullName} and any related notes/conversations from the pipeline. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDeleteCandidate}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {showResume && resumeUrl && (
        <div className="border-b border-card-border bg-page-bg/40">
          <div className="flex items-center justify-between px-8 py-2.5 border-b border-card-border bg-white">
            <div className="flex items-center gap-3">
              <FileText className="h-4 w-4 text-emerald" />
              <span className="text-sm font-display font-semibold text-emerald-dark">Resume preview</span>
              <a href={resumeUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald hover:text-emerald-dark hover:underline flex items-center gap-1">
                Open in new tab <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowResume(false)} title="Hide preview">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <iframe src={resumeUrl} className="w-full h-[80vh] bg-white" title="Resume" />
        </div>
      )}

      {/* Main content: left panel + right sidebar */}
      <div className="flex flex-1 overflow-hidden bg-page-bg">

        {/* ============ LEFT PANEL (70-75%) ============ */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ flex: '3 1 0%' }}>

          {/* Contact info grid */}
          <div className="px-8 py-5 border-b border-border">
            {canEdit && (
              <div className="flex justify-end mb-2">
                <button
                  onClick={() => setEditingInfo(!editingInfo)}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    editingInfo
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                >
                  <Edit className="h-3 w-3" />
                  {editingInfo ? 'Done Editing' : 'Edit Info'}
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
              <EditableField label="First Name" value={candidate.first_name} onSave={v => updateField('first_name', v)} disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Last Name" value={candidate.last_name} onSave={v => updateField('last_name', v)} disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Title" value={candidate.current_title} onSave={v => updateField('current_title', v)} placeholder="e.g. VP, Risk" disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Phone" value={candidate.phone} onSave={v => updateField('phone', v)} placeholder="+1 (555) 000-0000" disabled={!canEdit} highlight={editingInfo} />
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <EditableField label="Company" value={candidate.current_company} onSave={v => updateField('current_company', v)} placeholder="Firm name" disabled={!canEdit} highlight={editingInfo} />
                </div>
                {(candidate as any).company_id && (
                  <button
                    onClick={() => navigate(`/companies/${(candidate as any).company_id}`)}
                    title="View company"
                    className="shrink-0 mb-1 p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <EditableField label="LinkedIn URL" value={candidate.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/in/..." disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Location" value={c.location_text} onSave={v => updateField('location_text', v)} placeholder="City, State" disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Work Auth" value={c.work_authorization} onSave={v => updateField('work_authorization', v)} placeholder="Citizen, GC, H1-B..." disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Relocation" value={c.relocation_preference} onSave={v => updateField('relocation_preference', v)} placeholder="Open, No, NYC only..." disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Target Locations" value={c.target_locations} onSave={v => updateField('target_locations', v)} placeholder="NYC, Chicago..." disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Target Roles" value={c.target_roles} onSave={v => updateField('target_roles', v)} placeholder="PM, Quant, Tech..." disabled={!canEdit} highlight={editingInfo} />
              <EditableField
                label="Work Email"
                value={c.work_email}
                onSave={v => updateField('work_email', v)}
                type="email"
                placeholder="work@firm.com"
                disabled={!canEdit}
                highlight={editingInfo}
              />
              <EditableField label="Personal Email" value={c.personal_email} onSave={v => updateField('personal_email', v)} type="email" placeholder="personal@gmail.com" disabled={!canEdit} highlight={editingInfo} />
              <EditableField label="Mobile Phone" value={c.mobile_phone} onSave={async v => {
                await updateField('mobile_phone', v);
                // Keep legacy phone in sync
                if (v) await updateField('phone', v);
              }} placeholder="+1 (212) 555-0000" disabled={!canEdit} highlight={editingInfo} />
            </div>

            {/* Compensation — collapsible */}
            <div className="mt-4">
              <Collapsible open={compExpanded} onOpenChange={setCompExpanded}>
                <CollapsibleTrigger className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                  <DollarSign className="h-3 w-3" /> Compensation
                  {compExpanded ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
                    <EditableField label="Current Base" value={c.current_base_comp?.toString()} onSave={v => updateComp('current_base_comp', v)} placeholder="e.g. 200000" disabled={!canEdit} />
                    <EditableField label="Current Bonus" value={c.current_bonus_comp?.toString()} onSave={v => updateComp('current_bonus_comp', v)} placeholder="e.g. 150000" disabled={!canEdit} />
                    <EditableField label="Current Total" value={c.current_total_comp?.toString()} onSave={v => updateComp('current_total_comp', v)} placeholder="e.g. 350000" disabled={!canEdit} />
                    <EditableField label="Target Base" value={c.target_base_comp?.toString()} onSave={v => updateComp('target_base_comp', v)} placeholder="e.g. 250000" disabled={!canEdit} />
                    <EditableField label="Target Total" value={c.target_total_comp?.toString()} onSave={v => updateComp('target_total_comp', v)} placeholder="e.g. 400000" disabled={!canEdit} />
                    <EditableField label="Comp Notes" value={c.comp_notes} onSave={v => updateField('comp_notes', v)} placeholder="Deferred comp, RSUs, etc." disabled={!canEdit} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>

            {/* Timestamps + sentiment row */}
            <div className="flex items-center gap-6 mt-4 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Send className="h-3 w-3" /> Last Reached Out: {c.last_contacted_at ? format(new Date(c.last_contacted_at), 'MMM d, yyyy') : '—'}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> Last Response: {c.last_responded_at ? format(new Date(c.last_responded_at), 'MMM d, yyyy') : '—'}
              </span>
              {c.last_comm_channel && (
                <span className="inline-flex items-center gap-1 capitalize">
                  <ChannelIcon channel={c.last_comm_channel} />
                  {c.last_comm_channel === 'linkedin' ? 'LinkedIn' : c.last_comm_channel}
                </span>
              )}
              <SentimentChip sentiment={c.last_sequence_sentiment} note={c.last_sequence_sentiment_note} />
              <span>Added {format(new Date(candidate.created_at), 'MMM d, yyyy')}</span>
            </div>

            {/* Owner + Job assignment row */}
            <div className="flex items-center gap-4 mt-4 flex-wrap">
              <div className="space-y-1">
                <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Owner (Screener)</Label>
                <SearchableSelect
                  options={profiles.filter(p => p.full_name).map(p => ({ value: p.id, label: p.full_name || '' }))}
                  value={(candidate as any).owner_user_id ?? ''}
                  onChange={(val) => {
                    const newOwnerId = val || null;
                    if (newOwnerId && newOwnerId !== user?.id) {
                      setPendingOwnerId(newOwnerId);
                    } else {
                      (async () => {
                        try {
                          const { error } = await supabase.from('people').update({ owner_user_id: newOwnerId }).eq('id', id!);
                          if (error) { toast.error('Failed to update owner'); return; }
                          queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                          queryClient.invalidateQueries({ queryKey: ['candidates'] });
                          toast.success(newOwnerId ? 'Owner updated' : 'Owner removed');
                        } catch (err: any) {
                          toast.error(err?.message || 'Failed to update owner');
                        }
                      })();
                    }
                  }}
                  placeholder="Assign owner…"
                  searchPlaceholder="Search team…"
                  clearLabel="— Unassigned —"
                  className="h-7 text-xs w-44"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Active Job</Label>
                <SearchableSelect
                  options={(openJobs as any[]).map((j: any) => ({
                    value: j.id,
                    label: j.title,
                    sublabel: j.companies?.name || j.company_name || undefined,
                  }))}
                  value={candidate.job_id ?? ''}
                  onChange={async (val) => {
                    const newJobId = val || null;
                    try {
                      const { error } = await supabase.from('people').update({ job_id: newJobId, job_status: newJobId ? 'new' : null }).eq('id', id!);
                      if (error) { toast.error('Failed to update job assignment'); return; }
                      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                      queryClient.invalidateQueries({ queryKey: ['candidates'] });
                      toast.success(newJobId ? 'Job assigned' : 'Job removed');
                    } catch (err: any) {
                      toast.error(err?.message || 'Failed to update job assignment');
                    }
                  }}
                  placeholder="Assign a job…"
                  searchPlaceholder="Search jobs…"
                  clearLabel="— None —"
                  className="h-7 text-xs w-52"
                />
              </div>

              {candidate.job_id && (
                <div className="space-y-1">
                  <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Job Status</Label>
                  <Select value={c.job_status ?? ''} onValueChange={updateJobStatus} disabled={updatingJobStatus}>
                    <SelectTrigger className="h-7 text-xs w-36"><SelectValue placeholder="Set status…" /></SelectTrigger>
                    <SelectContent>
                      {SEND_OUT_STAGES.map(s => (
                        <SelectItem key={s.value} value={s.value}>
                          <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>{s.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Match score badge */}
              {candidateJobMatch && (
                <div className="flex items-center gap-2">
                  <span className={cn('px-2 py-0.5 rounded text-xs font-bold tabular-nums',
                    (candidateJobMatch as any).overall_score >= 80 ? 'text-green-400 bg-green-500/15' :
                    (candidateJobMatch as any).overall_score >= 60 ? 'text-yellow-400 bg-yellow-500/15' :
                    'text-muted-foreground bg-muted'
                  )}>
                    Match: {(candidateJobMatch as any).overall_score}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ---- Tabs ---- */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-3 border-b border-border">
              <TabsList className="bg-white border border-card-border">
                <TabsTrigger value="joe" className="gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Joe Says</TabsTrigger>
                <TabsTrigger value="background" className="gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Background</TabsTrigger>
                <TabsTrigger value="communications" className="gap-1.5"><MessageSquare className="h-3.5 w-3.5" /> Communications</TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5"><History className="h-3.5 w-3.5" /> Activity</TabsTrigger>
                <TabsTrigger value="documents" className="gap-1.5"><FolderOpen className="h-3.5 w-3.5" /> Documents</TabsTrigger>
                <TabsTrigger value="send-outs" className="gap-1.5"><Send className="h-3.5 w-3.5" /> Send Outs</TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5"><FileText className="h-3.5 w-3.5" /> Notes</TabsTrigger>
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
                  <div className="rounded-xl border border-accent/20 bg-accent/5 p-5 space-y-1 prose prose-sm max-w-none prose-headings:text-foreground prose-headings:font-semibold prose-headings:text-sm prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground">
                    {(c.joe_says as string).split('\n').map((line: string, i: number) => {
                      if (line.startsWith('## ')) return <h3 key={i} className="text-sm font-semibold text-foreground mt-3 mb-1">{line.replace('## ', '')}</h3>;
                      if (line.startsWith('- ')) return <p key={i} className="text-sm leading-relaxed text-foreground pl-3">{line}</p>;
                      return line.trim() ? (
                        <p key={i} className="text-sm leading-relaxed text-foreground">{line}</p>
                      ) : <div key={i} className="h-1" />;
                    })}
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

                {/* ── Ask Joe Chat ───────────────────────────────────────── */}
                <div className="mt-6 rounded-xl border border-border">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30 rounded-t-xl">
                    <Martini className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold">Ask Joe about this candidate</h3>
                  </div>
                  <div ref={joeChatScrollRef} className="h-64 overflow-y-auto p-4 space-y-3">
                    {joeChatMessages.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">Ask Joe anything — draft outreach, get comp insights, pitch ideas...</p>
                    )}
                    {joeChatMessages.map((msg, i) => (
                      <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                        <div className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                          msg.role === 'user' ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground'
                        )}>
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    {joeChatLoading && joeChatMessages[joeChatMessages.length - 1]?.role === 'user' && (
                      <div className="flex justify-start">
                        <div className="bg-muted rounded-lg px-3 py-2"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={joeChatInput}
                        onChange={(e) => setJoeChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleJoeChatSend()}
                        placeholder="Ask Joe anything about this candidate..."
                        disabled={joeChatLoading}
                        className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      />
                      <Button size="icon" variant="gold" onClick={handleJoeChatSend} disabled={joeChatLoading}>
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="background" className="px-8 py-5 mt-0 space-y-6">
                <EditableTextarea label="Candidate Summary" value={c.candidate_summary} onSave={v => updateField('candidate_summary', v)} placeholder="General background and career overview..." rows={5} />
                <EditableTextarea label="Back of Resume Notes" value={c.back_of_resume_notes} onSave={v => updateField('back_of_resume_notes', v)} placeholder="Products, business lines, divisions, function, motivations from phone screen..." rows={6} />
                <EditableTextarea label="Reason for Leaving / Job Change History" value={c.reason_for_leaving} onSave={v => updateField('reason_for_leaving', v)} placeholder="Why they're looking and pattern of moves..." rows={3} />
                <EditableTextarea label="Fun Facts / Personal" value={c.fun_facts} onSave={v => updateField('fun_facts', v)} placeholder="Hobbies, interests, personal connection points..." rows={2} />
                <div className="grid grid-cols-2 gap-4">
                  <EditableField label="Visa Status" value={c.visa_status} onSave={v => updateField('visa_status', v)} placeholder="e.g. US Citizen, H-1B, Green Card" />
                  <EditableField label="Notice Period" value={c.notice_period} onSave={v => updateField('notice_period', v)} placeholder="e.g. 2 weeks, 30 days" />
                </div>
                <EditableTextarea label="Where Interviewed" value={c.where_interviewed} onSave={v => updateField('where_interviewed', v)} placeholder="Firms / companies currently interviewing at..." rows={2} />
                <EditableTextarea label="Where Submitted" value={c.where_submitted} onSave={v => updateField('where_submitted', v)} placeholder="Firms / companies submitted to by other recruiters..." rows={2} />

                {/* ── Work History ──────────────────────────────────────── */}
                <div className="border-t border-border pt-5">
                  <Collapsible open={workHistoryOpen} onOpenChange={setWorkHistoryOpen}>
                    <CollapsibleTrigger className="flex items-center justify-between w-full group">
                      <div className="flex items-center gap-2">
                        <Briefcase className="h-4 w-4 text-accent" />
                        <h3 className="text-sm font-semibold text-foreground">Work History</h3>
                        <span className="text-xs text-muted-foreground">({workHistory.length})</span>
                      </div>
                      {workHistoryOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 space-y-3">
                      {workHistory.length === 0 && !showAddWork && (
                        <p className="text-sm text-muted-foreground">No work history recorded.</p>
                      )}
                      {workHistory.map((w: any) => (
                        <div key={w.id} className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-foreground">{w.title}</p>
                            {w.is_current && <Badge variant="secondary" className="text-[9px]">Current</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Building className="h-3 w-3" /> {w.company_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {w.start_date ? format(new Date(w.start_date), 'MMM yyyy') : '?'}
                            {' — '}
                            {w.is_current ? 'Present' : w.end_date ? format(new Date(w.end_date), 'MMM yyyy') : '?'}
                          </p>
                          {w.description && <p className="text-xs text-muted-foreground mt-1">{w.description}</p>}
                        </div>
                      ))}
                      {showAddWork ? (
                        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                          <h4 className="text-sm font-semibold">Add Work Experience</h4>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Company *</Label>
                              <Input className="h-8 text-sm" value={workForm.company_name} onChange={e => setWorkForm(f => ({ ...f, company_name: e.target.value }))} placeholder="Company name" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Title *</Label>
                              <Input className="h-8 text-sm" value={workForm.title} onChange={e => setWorkForm(f => ({ ...f, title: e.target.value }))} placeholder="Job title" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Start Date</Label>
                              <Input className="h-8 text-sm" type="date" value={workForm.start_date} onChange={e => setWorkForm(f => ({ ...f, start_date: e.target.value }))} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">End Date</Label>
                              <Input className="h-8 text-sm" type="date" value={workForm.end_date} onChange={e => setWorkForm(f => ({ ...f, end_date: e.target.value }))} disabled={workForm.is_current} />
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={workForm.is_current} onChange={e => setWorkForm(f => ({ ...f, is_current: e.target.checked, end_date: e.target.checked ? '' : f.end_date }))} className="rounded" />
                            Currently works here
                          </label>
                          <div className="space-y-1">
                            <Label className="text-xs">Description</Label>
                            <Input className="h-8 text-sm" value={workForm.description} onChange={e => setWorkForm(f => ({ ...f, description: e.target.value }))} placeholder="Brief description..." />
                          </div>
                          <div className="flex gap-2">
                            <Button variant="gold" size="sm" className="h-7 text-xs" onClick={handleAddWorkHistory} disabled={savingWork || !workForm.company_name || !workForm.title}>
                              {savingWork && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddWork(false)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowAddWork(true)}>
                          <Plus className="h-3 w-3 mr-1" /> Add Work Experience
                        </Button>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                </div>

                {/* ── Education ─────────────────────────────────────────── */}
                <div className="border-t border-border pt-5">
                  <Collapsible open={educationOpen} onOpenChange={setEducationOpen}>
                    <CollapsibleTrigger className="flex items-center justify-between w-full group">
                      <div className="flex items-center gap-2">
                        <GraduationCap className="h-4 w-4 text-accent" />
                        <h3 className="text-sm font-semibold text-foreground">Education</h3>
                        <span className="text-xs text-muted-foreground">({education.length})</span>
                      </div>
                      {educationOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 space-y-3">
                      {education.length === 0 && !showAddEducation && (
                        <p className="text-sm text-muted-foreground">No education history recorded.</p>
                      )}
                      {education.map((e: any) => (
                        <div key={e.id} className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
                          <p className="text-sm font-medium text-foreground">{e.institution}</p>
                          {(e.degree || e.field_of_study) && (
                            <p className="text-xs text-muted-foreground">
                              {e.degree}{e.degree && e.field_of_study ? ' in ' : ''}{e.field_of_study}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">{e.start_year ?? '?'} — {e.end_year ?? '?'}</p>
                        </div>
                      ))}
                      {showAddEducation ? (
                        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                          <h4 className="text-sm font-semibold">Add Education</h4>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1 col-span-2">
                              <Label className="text-xs">Institution *</Label>
                              <Input className="h-8 text-sm" value={eduForm.institution} onChange={e => setEduForm(f => ({ ...f, institution: e.target.value }))} placeholder="University name" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Degree</Label>
                              <Input className="h-8 text-sm" value={eduForm.degree} onChange={e => setEduForm(f => ({ ...f, degree: e.target.value }))} placeholder="e.g. BS, MBA" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Field of Study</Label>
                              <Input className="h-8 text-sm" value={eduForm.field_of_study} onChange={e => setEduForm(f => ({ ...f, field_of_study: e.target.value }))} placeholder="e.g. Finance" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Start Year</Label>
                              <Input className="h-8 text-sm" type="number" value={eduForm.start_year} onChange={e => setEduForm(f => ({ ...f, start_year: e.target.value }))} placeholder="2015" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">End Year</Label>
                              <Input className="h-8 text-sm" type="number" value={eduForm.end_year} onChange={e => setEduForm(f => ({ ...f, end_year: e.target.value }))} placeholder="2019" />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="gold" size="sm" className="h-7 text-xs" onClick={handleAddEducation} disabled={savingEducation || !eduForm.institution}>
                              {savingEducation && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddEducation(false)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowAddEducation(true)}>
                          <Plus className="h-3 w-3 mr-1" /> Add Education
                        </Button>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </TabsContent>

              <TabsContent value="communications" className="px-8 py-5 mt-0">
                <div className="flex items-center gap-2 mb-5">
                  <Button variant="outline" size="sm" onClick={() => {
                    const to = (candidate as any).personal_email || (candidate as any).work_email || candidate.email;
                    if (to) { window.location.href = `mailto:${to}`; }
                    else { toast.error('No email address on file'); }
                  }}><Mail className="h-3.5 w-3.5 mr-1" /> Email</Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (candidate.phone) { window.location.href = `tel:${candidate.phone}`; }
                    else { toast.error('No phone number on file'); }
                  }}><Phone className="h-3.5 w-3.5 mr-1" /> Call</Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (candidate.linkedin_url) { window.open(candidate.linkedin_url, '_blank'); }
                    else { toast.error('No LinkedIn URL on file'); }
                  }}><Linkedin className="h-3.5 w-3.5 mr-1" /> LinkedIn</Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (candidate.phone) { window.location.href = `sms:${candidate.phone}`; }
                    else { toast.error('No phone number on file'); }
                  }}><MessageSquare className="h-3.5 w-3.5 mr-1" /> SMS</Button>
                </div>
                {(conversations as any[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No communications yet.</p>
                ) : (
                  <div className="space-y-3">
                    {(conversations as any[]).map((conv) => {
                      const messages = (conv.messages || []).sort(
                        (a: any, b: any) => new Date(a.sent_at || a.created_at).getTime() - new Date(b.sent_at || b.created_at).getTime()
                      );
                      const channelLabel = (conv.channel === 'linkedin' || conv.channel?.startsWith('linkedin'))
                        ? 'LinkedIn' : conv.channel?.charAt(0).toUpperCase() + conv.channel?.slice(1);
                      return (
                        <Collapsible key={conv.id}>
                          <div className="rounded-lg border border-border">
                            <CollapsibleTrigger className="w-full text-left p-4 hover:bg-muted/30 transition-colors">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {conv.channel === 'email' && <Mail className="h-3.5 w-3.5 text-muted-foreground" />}
                                  {(conv.channel === 'linkedin' || conv.channel?.startsWith('linkedin')) && <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />}
                                  {conv.channel === 'sms' && <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
                                  {!['email', 'sms'].includes(conv.channel) && !conv.channel?.startsWith('linkedin') && <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                                  <span className="text-sm font-medium">{channelLabel}</span>
                                  <Badge variant="secondary" className="text-[9px]">{messages.length} msg{messages.length !== 1 ? 's' : ''}</Badge>
                                </div>
                                <span className="text-xs text-muted-foreground">
                                  {conv.last_message_at ? format(new Date(conv.last_message_at), 'MMM d, yyyy') : ''}
                                </span>
                              </div>
                              {conv.subject && <p className="text-sm mt-1">{conv.subject}</p>}
                              {conv.last_message_preview && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{conv.last_message_preview}</p>}
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="border-t border-border px-4 py-3 space-y-3 max-h-96 overflow-y-auto">
                                {messages.map((msg: any) => (
                                  <div key={msg.id} className={cn('flex', msg.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
                                    <div className={cn(
                                      'max-w-[80%] rounded-lg px-3 py-2 text-sm',
                                      msg.direction === 'outbound'
                                        ? 'bg-accent/15 text-foreground'
                                        : 'bg-muted text-foreground'
                                    )}>
                                      {msg.subject && <p className="text-xs font-medium mb-1">{msg.subject}</p>}
                                      <p className="text-xs whitespace-pre-wrap break-words">{
                                        (msg.body || msg.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
                                      }</p>
                                      <p className="text-[10px] text-muted-foreground mt-1">
                                        {msg.sent_at || msg.created_at ? format(new Date(msg.sent_at || msg.created_at), 'MMM d, h:mm a') : ''}
                                        {msg.direction === 'outbound' ? ' · Sent' : ' · Received'}
                                      </p>
                                    </div>
                                  </div>
                                ))}
                                {messages.length === 0 && (
                                  <p className="text-xs text-muted-foreground text-center py-2">No messages in this conversation.</p>
                                )}
                              </div>
                            </CollapsibleContent>
                          </div>
                        </Collapsible>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="activity" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <History className="h-5 w-5 text-accent" />
                  <h2 className="text-base font-semibold">Activity Timeline</h2>
                </div>
                {(() => {
                  // Build merged timeline from all data sources
                  const events: { date: string; icon: React.ReactNode; title: string; detail: string; type: string }[] = [];

                  // Call logs
                  (callLogs as any[]).forEach((cl) => {
                    const dur = cl.duration_seconds ? `${Math.floor(cl.duration_seconds / 60)}:${(cl.duration_seconds % 60).toString().padStart(2, '0')}` : '';
                    events.push({
                      date: cl.started_at,
                      icon: cl.direction === 'outbound' ? <PhoneOutgoing className="h-3.5 w-3.5 text-info" /> : <PhoneIncoming className="h-3.5 w-3.5 text-success" />,
                      title: `${cl.direction === 'outbound' ? 'Outbound' : 'Inbound'} Call${dur ? ` (${dur})` : ''}`,
                      detail: cl.summary?.slice(0, 120) || '',
                      type: 'call',
                    });
                  });

                  // Conversations (latest message)
                  (conversations as any[]).forEach((conv) => {
                    events.push({
                      date: conv.last_message_at,
                      icon: <ChannelIcon channel={conv.channel} />,
                      title: `${conv.channel === 'linkedin' ? 'LinkedIn' : conv.channel?.charAt(0).toUpperCase() + conv.channel?.slice(1)} conversation`,
                      detail: conv.subject ? `${conv.subject} — ${conv.last_message_preview || ''}` : conv.last_message_preview || '',
                      type: 'message',
                    });
                  });

                  // Notes
                  (notes as any[]).forEach((n) => {
                    const text = n.note?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '';
                    events.push({
                      date: n.created_at,
                      icon: <Edit className="h-3.5 w-3.5 text-muted-foreground" />,
                      title: 'Note added',
                      detail: text.slice(0, 120),
                      type: 'note',
                    });
                  });

                  // Send-outs
                  sendOuts.forEach((s: any) => {
                    events.push({
                      date: s.created_at,
                      icon: <Briefcase className="h-3.5 w-3.5 text-accent" />,
                      title: `Submitted to ${(s.jobs as any)?.title || 'job'}`,
                      detail: `${(s.jobs as any)?.company_name || ''} — Stage: ${s.stage || '—'}`,
                      type: 'sendout',
                    });
                  });

                  // Sort by date descending
                  events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

                  if (events.length === 0) {
                    return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;
                  }

                  return (
                    <div className="space-y-3">
                      {events.map((ev, i) => (
                        <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/20 p-3">
                          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            {ev.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium text-foreground">{ev.title}</p>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {ev.date ? format(new Date(ev.date), 'MMM d, yyyy h:mm a') : '—'}
                              </span>
                            </div>
                            {ev.detail && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{ev.detail}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </TabsContent>

              {/* ── Documents Tab (Resumes / Formatted / Other) ────────── */}
              <TabsContent value="documents" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-5 w-5 text-accent" />
                    <h2 className="text-base font-semibold">Documents</h2>
                  </div>
                </div>
                {/* Sub-folder tabs */}
                <div className="flex gap-1 border-b border-border">
                  {([
                    { key: 'resumes' as const, label: 'Resumes', count: candidateResumes.length },
                    { key: 'formatted' as const, label: 'Formatted', count: formattedResumes.length },
                    { key: 'other' as const, label: 'Other', count: otherDocs.length },
                  ]).map(f => (
                    <button
                      key={f.key}
                      onClick={() => setDocFolder(f.key)}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px',
                        docFolder === f.key
                          ? 'border-accent text-accent'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {f.label} <span className="ml-1 text-muted-foreground">({f.count})</span>
                    </button>
                  ))}
                </div>

                {/* Resumes folder */}
                {docFolder === 'resumes' && (
                  <div className="space-y-3">
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile}>
                        {uploadingFile ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                        Upload Resume
                      </Button>
                      <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.rtf" className="hidden"
                        onChange={e => { const file = e.target.files?.[0]; if (file) handleFileUpload(file); e.target.value = ''; }} />
                    </div>
                    {candidateResumes.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-8 text-center">
                        <FileText className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No resumes uploaded yet.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {candidateResumes.map((r: any) => {
                          const downloadUrl = r.file_path ? signedUrls[r.file_path] : null;
                          return (
                            <div key={r.id} className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <FileText className="h-4 w-4 text-accent shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">{r.file_name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {r.file_size && <span className="mr-2">{(r.file_size / 1024).toFixed(0)} KB</span>}
                                    {r.created_at && format(new Date(r.created_at), 'MMM d, yyyy')}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {downloadUrl && (
                                  <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1">
                                    <ExternalLink className="h-3.5 w-3.5" /> View
                                  </a>
                                )}
                                {isAdmin && (
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <button className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Delete resume?</AlertDialogTitle>
                                        <AlertDialogDescription>This will permanently delete "{r.file_name}". This cannot be undone.</AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => handleDeleteDocument('resumes', r.id, r.file_path)}>Delete</AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Formatted folder */}
                {docFolder === 'formatted' && (
                  <div className="space-y-3">
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file'; input.accept = '.pdf,.doc,.docx';
                        input.onchange = (e) => {
                          const file = (e.target as HTMLInputElement).files?.[0];
                          if (file) {
                            const label = prompt('Version label (e.g. v1, final, client-ready):', `v${formattedResumes.length + 1}`);
                            if (label !== null) handleFormattedUpload(file, label);
                          }
                        };
                        input.click();
                      }} disabled={uploadingFormatted}>
                        {uploadingFormatted ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                        Upload Formatted
                      </Button>
                    </div>
                    {formattedResumes.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-8 text-center">
                        <FileText className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No formatted resumes yet.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {formattedResumes.map((r: any) => {
                          const downloadUrl = r.file_path ? signedUrls[r.file_path] : null;
                          return (
                            <div key={r.id} className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <FileText className="h-4 w-4 text-accent shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">
                                    {r.file_name}
                                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent">{r.version_label}</span>
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {r.file_size && <span className="mr-2">{(r.file_size / 1024).toFixed(0)} KB</span>}
                                    {r.created_at && format(new Date(r.created_at), 'MMM d, yyyy')}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {downloadUrl && (
                                  <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1">
                                    <ExternalLink className="h-3.5 w-3.5" /> View
                                  </a>
                                )}
                                {isAdmin && (
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <button className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Delete formatted resume?</AlertDialogTitle>
                                        <AlertDialogDescription>This will permanently delete "{r.file_name}". This cannot be undone.</AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => handleDeleteDocument('formatted_resumes', r.id, r.file_path)}>Delete</AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Other folder */}
                {docFolder === 'other' && (
                  <div className="space-y-3">
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => otherDocInputRef.current?.click()} disabled={uploadingOtherDoc}>
                        {uploadingOtherDoc ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                        Upload Document
                      </Button>
                      <input ref={otherDocInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.rtf,.xlsx,.csv,.png,.jpg,.jpeg" className="hidden"
                        onChange={e => { const file = e.target.files?.[0]; if (file) handleOtherDocUpload(file); e.target.value = ''; }} />
                    </div>
                    {otherDocs.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-8 text-center">
                        <FileText className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No other documents yet.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {otherDocs.map((d: any) => {
                          const downloadUrl = d.file_path ? signedUrls[d.file_path] : null;
                          return (
                            <div key={d.id} className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <FileText className="h-4 w-4 text-accent shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">{d.file_name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {d.file_size && <span className="mr-2">{(d.file_size / 1024).toFixed(0)} KB</span>}
                                    {d.created_at && format(new Date(d.created_at), 'MMM d, yyyy')}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {downloadUrl && (
                                  <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1">
                                    <ExternalLink className="h-3.5 w-3.5" /> View
                                  </a>
                                )}
                                {isAdmin && (
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <button className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Delete document?</AlertDialogTitle>
                                        <AlertDialogDescription>This will permanently delete "{d.file_name}". This cannot be undone.</AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => handleDeleteDocument('candidate_documents', d.id, d.file_path)}>Delete</AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>

              {/* ── Send Outs Tab ─────────────────────────────────────────── */}
              <TabsContent value="send-outs" className="px-8 py-5 mt-0 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="h-5 w-5 text-accent" />
                    <h2 className="text-base font-semibold">Send Outs</h2>
                    <span className="text-xs text-muted-foreground">({sendOuts.length})</span>
                  </div>
                  {!addingSendOut && (
                    <Button variant="gold" size="sm" onClick={() => setAddingSendOut(true)}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add to Job
                    </Button>
                  )}
                </div>

                {/* Add send out form */}
                {addingSendOut && (
                  <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                    <h4 className="text-sm font-semibold">Add Candidate to Job Pipeline</h4>
                    <SearchableSelect
                      options={(openJobs as any[]).map((j: any) => ({
                        value: j.id,
                        label: j.title,
                        sublabel: j.companies?.name || j.company_name || undefined,
                      }))}
                      value={selectedJobForSendOut}
                      onChange={setSelectedJobForSendOut}
                      placeholder="Select a job..."
                      searchPlaceholder="Search jobs…"
                      emptyText="No jobs found."
                    />
                    <div className="flex gap-2">
                      <Button variant="gold" size="sm" className="h-7 text-xs" onClick={handleAddSendOut} disabled={savingSendOut || !selectedJobForSendOut}>
                        {savingSendOut && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Add
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setAddingSendOut(false); setSelectedJobForSendOut(''); }}>Cancel</Button>
                    </div>
                  </div>
                )}

                {sendOuts.length === 0 && !addingSendOut ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Send className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No send outs</p>
                    <p className="text-xs text-muted-foreground mb-4">Add this candidate to a job pipeline to track their progress.</p>
                    <Button variant="gold" size="sm" onClick={() => setAddingSendOut(true)}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add to Job
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sendOuts.map((so: any) => {
                      const j = so.jobs;
                      const canonicalStage = stageToCanonical(so.stage);
                      const stageCfg = canonicalStage ? SEND_OUT_STAGES.find(s => s.value === canonicalStage) : undefined;
                      const isRejected = canonicalStage === 'withdrawn';
                      const isRejecting = rejectingId === so.id;
                      const isSendOutOwner = so.recruiter_id === user?.id || isAdmin;
                      return (
                        <div key={so.id} className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 cursor-pointer" onClick={() => j?.id && navigate(`/jobs/${j.id}`)}>
                              <p className="text-sm font-medium text-foreground hover:text-accent transition-colors">{j?.title ?? 'Unknown Job'}</p>
                              <p className="text-xs text-muted-foreground">
                                {j?.company_name && <span>{j.company_name}</span>}
                                {j?.location && <span> &middot; {j.location}</span>}
                                <span className="ml-2">{so.created_at ? format(new Date(so.created_at), 'MMM d, yyyy') : ''}</span>
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {stageCfg && (
                                <span className={cn('px-2 py-0.5 rounded text-xs font-medium', stageCfg.color)}>
                                  {stageCfg.label}
                                </span>
                              )}
                              {isSendOutOwner && (
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-400" onClick={() => handleDeleteSendOut(so.id)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {/* Stage selector — only visible to the recruiter who created this send out */}
                          {!isRejected && !isRejecting && isSendOutOwner && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {SEND_OUT_STAGES.filter(s => s.value !== 'withdrawn').map(s => (
                                <button
                                  key={s.value}
                                  onClick={() => handleUpdateStage(so.id, s.value)}
                                  className={cn(
                                    'px-2 py-0.5 rounded text-[10px] font-medium transition-all border',
                                    canonicalStage === s.value
                                      ? cn(s.color, 'border-current')
                                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                                  )}
                                >
                                  {s.label}
                                </button>
                              ))}
                              <button
                                onClick={() => { setRejectingId(so.id); setRejectForm({ rejected_by: '', rejection_reason: '', feedback: '' }); }}
                                className="px-2 py-0.5 rounded text-[10px] font-medium border border-transparent text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all"
                              >
                                Reject
                              </button>
                            </div>
                          )}

                          {/* Rejection details (when already rejected) */}
                          {isRejected && !isRejecting && (
                            <div className="rounded-md bg-red-500/5 border border-red-500/20 p-3 space-y-1">
                              <p className="text-xs font-medium text-red-400">Rejected {so.rejected_by ? `— ${REJECTED_BY_OPTIONS.find(o => o.value === so.rejected_by)?.label ?? so.rejected_by}` : ''}</p>
                              {so.rejection_reason && <p className="text-xs text-muted-foreground"><span className="font-medium">Reason:</span> {so.rejection_reason}</p>}
                              {so.feedback && <p className="text-xs text-muted-foreground"><span className="font-medium">Feedback:</span> {so.feedback}</p>}
                              {isSendOutOwner && <button onClick={() => { setRejectingId(so.id); setRejectForm({ rejected_by: so.rejected_by || '', rejection_reason: so.rejection_reason || '', feedback: so.feedback || '' }); }} className="text-[10px] text-accent hover:underline mt-1">Edit</button>}
                            </div>
                          )}

                          {/* Rejection form */}
                          {isRejecting && (
                            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                              <h5 className="text-xs font-semibold text-red-400">Rejection Details</h5>
                              <div className="space-y-1">
                                <Label className="text-xs">Rejected By *</Label>
                                <Select value={rejectForm.rejected_by} onValueChange={v => setRejectForm(f => ({ ...f, rejected_by: v }))}>
                                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Who rejected?" /></SelectTrigger>
                                  <SelectContent>
                                    {REJECTED_BY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Reason</Label>
                                <Input className="h-8 text-sm" value={rejectForm.rejection_reason} onChange={e => setRejectForm(f => ({ ...f, rejection_reason: e.target.value }))} placeholder="Why was this rejected?" />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Feedback</Label>
                                <textarea value={rejectForm.feedback} onChange={e => setRejectForm(f => ({ ...f, feedback: e.target.value }))}
                                  className="w-full rounded-md border border-input bg-background text-foreground p-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                                  rows={2} placeholder="Additional feedback..." />
                              </div>
                              <div className="flex gap-2">
                                <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => handleReject(so.id)} disabled={!rejectForm.rejected_by}>
                                  Confirm Rejection
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setRejectingId(null)}>Cancel</Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="notes" className="px-8 py-5 mt-0">
                <EntityNotesTab entityType="candidate" entityId={id!} placeholder="Add a note about this candidate — call summary, screening notes, anything the team should see…" />
              </TabsContent>

            </ScrollArea>
          </Tabs>
        </div>

        {/* ============ RIGHT SIDEBAR (25-30%) ============ */}
        <aside className="w-80 shrink-0 border-l border-border flex flex-col overflow-hidden" style={{ flex: '0 0 320px' }}>
          {/* Sidebar sub-tabs */}
          <div className="px-4 pt-4 pb-2 border-b border-border space-y-3">
            <div className="flex items-center gap-1 flex-wrap">
              {(['all', 'notes', 'tasks', 'meetings'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize',
                    sidebarTab === tab
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                >
                  {tab === 'all' ? 'All' : tab === 'notes' ? 'Notes & Calls' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search activity..."
                value={sidebarSearch}
                onChange={e => setSidebarSearch(e.target.value)}
                className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-foreground text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {/* NOTES section (shown on all, notes tabs) */}
              {(sidebarTab === 'all' || sidebarTab === 'notes') && (
                <div className="space-y-3">
                  <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Notes</h3>
                  <RichTextEditor
                    value={noteText}
                    onChange={setNoteText}
                    placeholder="Add a note..."
                    minHeight="60px"
                  />
                  <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={savingNote || !noteText.trim()} className="w-full">
                    {savingNote && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />} Save Note
                  </Button>
                  {filteredNotes.length > 0 ? (
                    <div className="space-y-2">
                      {filteredNotes.map((n: any) => (
                        <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-3">
                          <div className="text-xs prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: n.note }} />
                          <p className="text-[10px] text-muted-foreground mt-1.5">
                            {format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No notes yet.</p>
                  )}
                </div>
              )}

              {/* CALLS section (shown on all, notes tabs) */}
              {(sidebarTab === 'all' || sidebarTab === 'notes') && (
                <div>
                  {sidebarTab === 'all' && <div className="border-t border-border my-3" />}
                  <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 mb-3">
                    <PhoneCall className="h-3 w-3" /> Calls
                    <span className="text-muted-foreground font-normal">({(callLogs as any[]).length})</span>
                  </h3>
                  {filteredCallLogs.length === 0 && (callNotes as any[]).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No calls yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {filteredCallLogs.map((call: any) => {
                        const isOut = call.direction === 'outbound';
                        const dur = call.duration_seconds;
                        const durStr = dur ? `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}` : '--:--';
                        const aiNote = (callNotes as any[]).find((n: any) => n.call_log_id === call.id || n.external_call_id === call.external_call_id);
                        return (
                          <button
                            key={call.id}
                            onClick={() => setSelectedCall({ call, aiNote })}
                            className="w-full text-left rounded-md border border-border bg-secondary/30 p-2.5 hover:border-accent/40 transition-all"
                          >
                            <div className="flex items-center gap-2">
                              <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', isOut ? 'bg-info/10 text-info' : 'bg-success/10 text-success')}>
                                {isOut ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-foreground">{isOut ? 'Outbound' : 'Inbound'}</span>
                                  {call.audio_url && <Volume2 className="h-2.5 w-2.5 text-accent shrink-0" />}
                                  {aiNote && <Badge variant="secondary" className="text-[8px] px-1 py-0">AI</Badge>}
                                </div>
                                <p className="text-[10px] text-muted-foreground">{call.started_at ? format(new Date(call.started_at), 'MMM d, h:mm a') : '—'} · {durStr}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                      {/* Orphan AI notes */}
                      {(callNotes as any[]).filter((n: any) => !(callLogs as any[]).some((cl: any) => cl.id === n.call_log_id || (cl.external_call_id && cl.external_call_id === n.external_call_id))).map((note: any, idx: number) => (
                        <button
                          key={note.id ?? idx}
                          onClick={() => setSelectedCall({ call: { id: note.id, direction: note.call_direction || 'outbound', phone_number: note.phone_number || '', duration_seconds: note.call_duration_seconds, started_at: note.call_started_at || note.created_at, audio_url: note.recording_url, summary: note.ai_summary, notes: note.extracted_notes, linked_entity_name: c.full_name }, aiNote: note })}
                          className="w-full text-left rounded-md border border-border bg-secondary/30 p-2.5 hover:border-accent/40 transition-all"
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                              <PhoneCall className="h-3.5 w-3.5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-foreground">Call Notes</span>
                                <Badge variant="secondary" className="text-[8px] px-1 py-0">AI</Badge>
                              </div>
                              <p className="text-[10px] text-muted-foreground">{note.call_started_at ? format(new Date(note.call_started_at), 'MMM d, h:mm a') : note.created_at ? format(new Date(note.created_at), 'MMM d') : '—'}</p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TASKS section (shown on all, tasks tabs) */}
              {/* TASKS section */}
              {(sidebarTab === 'all' || sidebarTab === 'tasks') && (
                <div>
                  {sidebarTab === 'all' && <div className="border-t border-border my-3" />}
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                      <FileText className="h-3 w-3" /> Tasks ({regularTasks.length})
                    </h3>
                    <button onClick={() => setCreateTaskOpen(true)} className="text-[10px] text-accent hover:underline">+ Add</button>
                  </div>
                  {regularTasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tasks yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {regularTasks.map((t: Task) => <TaskCard key={t.id} task={t} />)}
                    </div>
                  )}
                </div>
              )}

              {/* MEETINGS section */}
              {(sidebarTab === 'all' || sidebarTab === 'meetings') && (
                <div>
                  {sidebarTab === 'all' && <div className="border-t border-border my-3" />}
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                      <Calendar className="h-3 w-3" /> Meetings ({meetings.length})
                    </h3>
                  </div>
                  {meetings.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No meetings scheduled.</p>
                  ) : (
                    <div className="space-y-2">
                      {meetings.map((m: Task) => (
                        <div key={m.id} className="rounded-lg border border-border bg-card p-3 space-y-1.5">
                          <p className="text-sm font-medium truncate">{m.title}</p>
                          {m.start_time && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {format(new Date(m.start_time), 'MMM d, yyyy')}
                              {' '}
                              {format(new Date(m.start_time), 'h:mm a')}
                              {m.end_time && ` – ${format(new Date(m.end_time), 'h:mm a')}`}
                            </p>
                          )}
                          {m.location && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 shrink-0" /> {m.location}
                            </p>
                          )}
                          {m.meeting_url && (
                            <a href={m.meeting_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline flex items-center gap-1">
                              <ExternalLink className="h-3 w-3" /> Join Meeting
                            </a>
                          )}
                          <button
                            onClick={() => setEditingMeeting(m)}
                            className="text-[10px] text-accent hover:underline mt-1"
                          >
                            Edit Details
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>

      {/* CallDetailModal — rendered at component root for proper portal behavior */}
      <CallDetailModal
        open={!!selectedCall}
        onOpenChange={(v) => !v && setSelectedCall(null)}
        call={selectedCall?.call}
        aiNotes={selectedCall?.aiNote}
      />

      <ScheduleMeetingDialog
        open={scheduleMeetingOpen}
        onOpenChange={setScheduleMeetingOpen}
        attendee={candidate ? {
          id: candidate.id,
          type: 'candidate',
          name: candidate.full_name || `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`.trim() || 'Candidate',
          email: (candidate as any).primary_email ?? (candidate as any).personal_email ?? (candidate as any).work_email ?? null,
        } : undefined}
        defaultSubject={candidate ? `Meeting w/ ${candidate.full_name || candidate.first_name || 'candidate'}` : undefined}
      />

      {/* Owner transfer confirmation */}
      <AlertDialog open={!!pendingOwnerId} onOpenChange={(open) => { if (!open) setPendingOwnerId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer ownership?</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to transfer ownership of this candidate to <strong>{pendingOwnerName}</strong>. You will lose the ability to edit this candidate's fields after the transfer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              const { error } = await supabase
                .from('people')
                .update({ owner_user_id: pendingOwnerId })
                .eq('id', id!);
              if (error) {
                toast.error(error.message || 'Failed to transfer owner');
                return;
              }
              queryClient.invalidateQueries({ queryKey: ['candidate', id] });
              queryClient.invalidateQueries({ queryKey: ['candidates'] });
              toast.success('Owner transferred');
              setPendingOwnerId(null);
            }}>
              Transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EnrollInSequenceDialog open={enrollOpen} onOpenChange={setEnrollOpen} candidateIds={id ? [id] : []} candidateNames={[fullName]} />

      {candidate && (
        <MergeCandidateDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          currentCandidate={{
            id: candidate.id,
            first_name: candidate.first_name,
            last_name: candidate.last_name,
            email: (candidate as any).primary_email ?? (candidate as any).personal_email ?? (candidate as any).work_email ?? null,
            current_title: candidate.current_title,
            current_company: candidate.current_company,
          }}
        />
      )}

      {/* Edit meeting dialog */}
      {editingMeeting && (
        <EditMeetingDialog
          open={!!editingMeeting}
          onOpenChange={(open) => { if (!open) setEditingMeeting(null); }}
          task={editingMeeting}
          companyId={candidate?.job_id ? (jobs as any[]).find((j: any) => j.id === candidate.job_id)?.company_id : null}
        />
      )}

      {/* Create task dialog */}
      <CreateTaskDialog
        open={createTaskOpen}
        onOpenChange={setCreateTaskOpen}
        defaultLinks={id ? [{ entity_type: 'candidate', entity_id: id }] : []}
      />
    </MainLayout>
  );
};

export default CandidateDetail;
