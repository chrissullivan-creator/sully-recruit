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
} from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { CallDetailModal } from '@/components/shared/CallDetailModal';

const SEND_OUT_STAGES = [
  { value: 'new',          label: 'New',          color: 'bg-slate-500/15 text-slate-400' },
  { value: 'reached_out',  label: 'Reached Out',  color: 'bg-blue-500/15 text-blue-400' },
  { value: 'pitch',        label: 'Pitch',        color: 'bg-indigo-500/15 text-indigo-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'sent',         label: 'Sent',         color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
];

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

const EditableField = ({ label, value, onSave, type = 'text', placeholder, disabled = false }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string; disabled?: boolean;
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
        <div className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 -mx-1.5 transition-colors", disabled ? '' : 'cursor-pointer hover:bg-accent/10')} onClick={() => !disabled && setEditing(true)}>
          <span className={cn('text-sm flex-1 truncate', value ? 'text-foreground' : 'text-muted-foreground italic')}>
            {value || placeholder || '—'}
          </span>
          {!disabled && <Edit className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />}
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
  const isOwner = !!(user && candidate && (candidate as any).owner_id === user.id);
  const canEdit = isOwner || isAdmin;
  const [pendingOwnerId, setPendingOwnerId] = useState<string | null>(null);
  const pendingOwnerName = pendingOwnerId ? profiles.find(p => p.id === pendingOwnerId)?.full_name ?? 'this user' : '';

  const handleFormattedUpload = async (file: File, versionLabel: string) => {
    if (!id) return;
    setUploadingFormatted(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const path = `${session.user.id}/${id}/formatted/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
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
      const path = `${session.user.id}/${id}/other/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
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
        stage: 'lead',
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
    const updates: any = { stage: newStage, updated_at: new Date().toISOString() };
    if (newStage === 'sent_to_client') updates.sent_to_client_at = new Date().toISOString();
    if (newStage === 'interviewing') updates.interview_at = new Date().toISOString();
    if (newStage === 'offer') updates.offer_at = new Date().toISOString();
    if (newStage === 'placed') updates.placed_at = new Date().toISOString();

    const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOutId);
    if (error) { toast.error('Failed to update stage'); return; }
    queryClient.invalidateQueries({ queryKey: ['candidate_send_outs', id] });
    toast.success(`Stage updated to ${SEND_OUT_STAGES.find(s => s.value === newStage)?.label ?? newStage}`);
  };

  const handleReject = async (sendOutId: string) => {
    if (!rejectForm.rejected_by) { toast.error('Please select who rejected'); return; }
    const { error } = await supabase.from('send_outs').update({
      stage: 'rejected',
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
    const { error } = await supabase.from('send_outs').delete().eq('id', sendOutId);
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
      const path = `${session.user.id}/${id}/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
      const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from('resumes').getPublicUrl(path);
      const { error: dbErr } = await supabase.from('resumes').insert({
        candidate_id: id,
        file_name: file.name,
        file_path: path,
        file_url: urlData.publicUrl,
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
              const resp = await fetch('/api/trigger-sync-activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_type: 'candidate', entity_id: id }),
              });
              const data = await resp.json();
              if (data.error) throw new Error(data.error);
              toast.success('Activity sync triggered — results will update shortly');
              setTimeout(() => queryClient.invalidateQueries({ queryKey: ['candidate', id] }), 5000);
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
              <EditableField label="Email" value={candidate.email} onSave={v => updateField('email', v)} type="email" placeholder="email@domain.com" disabled={!canEdit} />
              <EditableField label="Phone" value={candidate.phone} onSave={v => updateField('phone', v)} placeholder="+1 (555) 000-0000" disabled={!canEdit} />
              <EditableField label="LinkedIn" value={candidate.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/in/..." disabled={!canEdit} />
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
              <EditableField label="First Name" value={candidate.first_name} onSave={v => updateField('first_name', v)} disabled={!canEdit} />
              <EditableField label="Last Name" value={candidate.last_name} onSave={v => updateField('last_name', v)} disabled={!canEdit} />
              <EditableField label="Title" value={candidate.current_title} onSave={v => updateField('current_title', v)} placeholder="e.g. VP, Risk" disabled={!canEdit} />
              <EditableField label="Company" value={candidate.current_company} onSave={v => updateField('current_company', v)} placeholder="Firm name" disabled={!canEdit} />
              <EditableField label="Location" value={c.location_text} onSave={v => updateField('location_text', v)} placeholder="City, State" disabled={!canEdit} />
            </div>

            <div className="space-y-2">
              <button className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest w-full" onClick={() => setCompExpanded(!compExpanded)}>
                <DollarSign className="h-3 w-3" /> Compensation
                {compExpanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {compExpanded && (
                <div className="space-y-2 pl-1">
                  <EditableField label="Current Base" value={c.current_base_comp?.toString()} onSave={v => updateComp('current_base_comp', v)} placeholder="e.g. 200000" disabled={!canEdit} />
                  <EditableField label="Current Bonus" value={c.current_bonus_comp?.toString()} onSave={v => updateComp('current_bonus_comp', v)} placeholder="e.g. 150000" disabled={!canEdit} />
                  <EditableField label="Current Total" value={c.current_total_comp?.toString()} onSave={v => updateComp('current_total_comp', v)} placeholder="e.g. 350000" disabled={!canEdit} />
                  <EditableField label="Target Base" value={c.target_base_comp?.toString()} onSave={v => updateComp('target_base_comp', v)} placeholder="e.g. 250000" disabled={!canEdit} />
                  <EditableField label="Target Total" value={c.target_total_comp?.toString()} onSave={v => updateComp('target_total_comp', v)} placeholder="e.g. 400000" disabled={!canEdit} />
                  <EditableField label="Comp Notes" value={c.comp_notes} onSave={v => updateField('comp_notes', v)} placeholder="Deferred comp, RSUs, etc." disabled={!canEdit} />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Preferences</h3>
              <EditableField label="Work Auth" value={c.work_authorization} onSave={v => updateField('work_authorization', v)} placeholder="Citizen, GC, H1-B..." disabled={!canEdit} />
              <EditableField label="Relocation" value={c.relocation_preference} onSave={v => updateField('relocation_preference', v)} placeholder="Open, No, NYC only..." disabled={!canEdit} />
              <EditableField label="Target Locations" value={c.target_locations} onSave={v => updateField('target_locations', v)} placeholder="NYC, Chicago..." disabled={!canEdit} />
              <EditableField label="Target Roles" value={c.target_roles} onSave={v => updateField('target_roles', v)} placeholder="PM, Quant, Tech..." disabled={!canEdit} />
              <EditableField label="Reason for Leaving" value={c.reason_for_leaving} onSave={v => updateField('reason_for_leaving', v)} placeholder="Comp, culture, layoff..." disabled={!canEdit} />
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest" title="Last recruiter who screened this candidate">Owner (Screener)</h3>
              <Select value={candidate.owner_id ?? 'none'} onValueChange={(val) => {
                const newOwnerId = val === 'none' ? null : val;
                if (newOwnerId && newOwnerId !== user?.id) {
                  setPendingOwnerId(newOwnerId);
                } else {
                  (async () => {
                    await supabase.from('candidates').update({ owner_id: newOwnerId }).eq('id', id!);
                    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                    queryClient.invalidateQueries({ queryKey: ['candidates'] });
                    toast.success(newOwnerId ? 'Owner updated' : 'Owner removed');
                  })();
                }
              }} disabled={!canEdit}>
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
              }} disabled={!canEdit}>
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
                    {SEND_OUT_STAGES.map(s => (
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
                <TabsTrigger value="documents" className="gap-1.5"><FolderOpen className="h-3.5 w-3.5" /> Documents</TabsTrigger>
                <TabsTrigger value="send-outs" className="gap-1.5"><Send className="h-3.5 w-3.5" /> Send Outs</TabsTrigger>
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
                    if (candidate.email) { window.location.href = `mailto:${candidate.email}`; }
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
                <RichTextEditor
                  value={noteText}
                  onChange={setNoteText}
                  placeholder="Add a note..."
                  minHeight="80px"
                />
                <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={savingNote || !noteText.trim()}>
                  {savingNote && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />} Save Note
                </Button>
                {(notes as any[]).length > 0 ? (
                  <div className="space-y-3">
                    {(notes as any[]).map((n) => (
                      <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-4">
                        <div className="text-sm prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: n.note }} />
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
                          const downloadUrl = r.file_url || (r.file_path ? supabase.storage.from('resumes').getPublicUrl(r.file_path).data?.publicUrl : null);
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
                              {downloadUrl && (
                                <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1 shrink-0">
                                  <ExternalLink className="h-3.5 w-3.5" /> View
                                </a>
                              )}
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
                          const downloadUrl = r.file_path ? supabase.storage.from('resumes').getPublicUrl(r.file_path).data?.publicUrl : null;
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
                              {downloadUrl && (
                                <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1 shrink-0">
                                  <ExternalLink className="h-3.5 w-3.5" /> View
                                </a>
                              )}
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
                          const downloadUrl = d.file_path ? supabase.storage.from('resumes').getPublicUrl(d.file_path).data?.publicUrl : null;
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
                              {downloadUrl && (
                                <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm flex items-center gap-1 shrink-0">
                                  <ExternalLink className="h-3.5 w-3.5" /> View
                                </a>
                              )}
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
                    <Select value={selectedJobForSendOut} onValueChange={setSelectedJobForSendOut}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select a job..." /></SelectTrigger>
                      <SelectContent>
                        {openJobs.map((j: any) => (
                          <SelectItem key={j.id} value={j.id}>
                            {j.title}{j.companies?.name ? ` — ${j.companies.name}` : j.company_name ? ` — ${j.company_name}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                      const stageCfg = SEND_OUT_STAGES.find(s => s.value === so.stage);
                      const isRejected = so.stage === 'rejected';
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
                              {SEND_OUT_STAGES.filter(s => s.value !== 'rejected').map(s => (
                                <button
                                  key={s.value}
                                  onClick={() => handleUpdateStage(so.id, s.value)}
                                  className={cn(
                                    'px-2 py-0.5 rounded text-[10px] font-medium transition-all border',
                                    so.stage === s.value
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

            </ScrollArea>
          </Tabs>
        </div>

      </div>

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
              await supabase.from('candidates').update({ owner_id: pendingOwnerId }).eq('id', id!);
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
    </MainLayout>
  );
};

export default CandidateDetail;
