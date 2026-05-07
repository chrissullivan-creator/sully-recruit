import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { useNotes, useJobs } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin,
  Edit, Briefcase, MessageSquare, History, User,
  FileText, Loader2, Check, X, ExternalLink,
  Clock, Search, Calendar, Users, Send,
  Sparkles, RefreshCw, Martini, Send as SendIcon,
  PhoneCall, PhoneIncoming, PhoneOutgoing, Trash2, CalendarPlus,
} from 'lucide-react';
import { ScheduleMeetingDialog } from '@/components/calendar/ScheduleMeetingDialog';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { EntityNotesTab } from '@/components/shared/EntityNotesTab';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { invalidatePersonScope, invalidateNoteScope, invalidateJobScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';

/* ------------------------------------------------------------------ */
/*  Inline hooks                                                       */
/* ------------------------------------------------------------------ */

function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ['contact', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, companies(*)')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

function useContactConversations(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact_conversations', contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('*, messages(*)')
        .eq('contact_id', contactId!)
        .order('last_message_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

function useContactSendOuts(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact_send_outs', contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select('*, candidate:people!candidate_id(id, full_name, first_name, last_name, current_title, current_company, email:primary_email, phone, status), jobs(id, title, company_name, location, status)')
        .eq('contact_id', contactId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });
}

function useContactJobs(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact_jobs', contactId],
    enabled: !!contactId,
    queryFn: async () => {
      // Jobs where this contact is hiring manager
      const { data: hiringManagerJobs, error: err1 } = await supabase
        .from('jobs')
        .select('*')
        .eq('hiring_manager', contactId!)
        .order('created_at', { ascending: false });
      if (err1) throw err1;

      // Jobs linked via send_outs
      const { data: sendOutJobs, error: err2 } = await supabase
        .from('send_outs')
        .select('jobs(id, title, company_name, location, status, created_at)')
        .eq('contact_id', contactId!);
      if (err2) throw err2;

      const soJobs = (sendOutJobs || [])
        .map((so: any) => so.jobs)
        .filter(Boolean);

      // Jobs linked via job_contacts table
      const { data: jobContactRows, error: err3 } = await supabase
        .from('job_contacts')
        .select('job_id, is_primary, jobs(id, title, company_name, location, status, created_at)')
        .eq('contact_id', contactId!);
      if (err3) throw err3;

      const jcJobs = (jobContactRows || [])
        .map((row: any) => ({ ...row.jobs, _job_contact_id: row.job_id }))
        .filter(Boolean);

      // Merge and deduplicate
      const allJobs = [...(hiringManagerJobs || []), ...soJobs, ...jcJobs];
      const seen = new Set<string>();
      return allJobs.filter((j: any) => {
        if (seen.has(j.id)) return false;
        seen.add(j.id);
        return true;
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Editable field components                                          */
/* ------------------------------------------------------------------ */

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
            {value || placeholder || '\u2014'}
          </span>
          <Edit className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

const CONTACT_STATUSES: Record<string, { label: string; className: string }> = {
  active:   { label: 'Active',   className: 'bg-success/10 text-success border-success/20' },
  inactive: { label: 'Inactive', className: 'bg-muted text-muted-foreground border-border' },
  client:   { label: 'Client',   className: 'bg-accent/15 text-accent border-accent/30' },
  lead:     { label: 'Lead',     className: 'bg-blue-500/15 text-blue-400 border-blue-500/20' },
};

const COMM_CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  linkedin: 'LinkedIn',
  linkedin_message: 'LinkedIn',
  sms: 'SMS',
  phone: 'Phone',
};

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

const ContactDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Data hooks
  const { data: contact, isLoading } = useContact(id);
  const { data: notes = [] } = useNotes(id, 'contact');
  const { data: conversations = [] } = useContactConversations(id);
  const { data: sendOuts = [] } = useContactSendOuts(id);
  const { data: linkedJobs = [] } = useContactJobs(id);

  // Call logs
  const { data: callLogs = [] } = useQuery({
    queryKey: ['call_logs', 'contact', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('call_logs')
        .select('*')
        .eq('linked_entity_id', id!)
        .eq('linked_entity_type', 'contact')
        .order('started_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  // Local state
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [activeTab, setActiveTab] = useState('joe');
  const [sidebarTab, setSidebarTab] = useState<'all' | 'notes' | 'tasks' | 'meetings'>('all');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [commFilter, setCommFilter] = useState<'all' | 'email' | 'linkedin' | 'sms'>('all');
  const [generatingJoe, setGeneratingJoe] = useState(false);
  const [joeChatMessages, setJoeChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [joeChatInput, setJoeChatInput] = useState('');
  const [joeChatLoading, setJoeChatLoading] = useState(false);
  const joeChatScrollRef = useRef<HTMLDivElement>(null);

  // Job linking state
  const [jobSearch, setJobSearch] = useState('');
  const [jobSearchOpen, setJobSearchOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [linkingJob, setLinkingJob] = useState(false);
  const [removingJobId, setRemovingJobId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleMeetingOpen, setScheduleMeetingOpen] = useState(false);
  const [deletingContact, setDeletingContact] = useState(false);

  const handleDeleteContact = async () => {
    if (!id) return;
    setDeletingContact(true);
    try {
      // contacts is a backwards-compat VIEW over people WHERE type='client'
      // — delete from people for clean cascade.
      const { error } = await softDelete('people', id);
      if (error) throw new Error(error.message);
      toast.success('Moved to trash — undo from /audit/trash within 30 days');
      invalidatePersonScope(queryClient);
      navigate('/contacts');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete contact');
    } finally {
      setDeletingContact(false);
      setConfirmDelete(false);
    }
  };

  const { data: allJobs = [] } = useJobs();

  const linkJob = async () => {
    if (!selectedJobId || !id) return;
    setLinkingJob(true);
    try {
      const isFirst = linkedJobs.length === 0;
      const { error } = await supabase.from('job_contacts').insert({
        job_id: selectedJobId,
        contact_id: id,
        is_primary: isFirst,
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['contact_jobs', id] });
      toast.success('Job linked');
      setSelectedJobId('');
      setJobSearch('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to link job');
    } finally {
      setLinkingJob(false);
    }
  };

  const unlinkJob = async (jobId: string) => {
    if (!id) return;
    setRemovingJobId(jobId);
    try {
      const { error } = await supabase
        .from('job_contacts')
        .delete()
        .eq('job_id', jobId)
        .eq('contact_id', id);
      if (error) throw error;
      invalidateJobScope(queryClient);
      toast.success('Job removed');
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove job');
    } finally {
      setRemovingJobId(null);
    }
  };

  /* ---- mutations ---- */

  const updateField = async (field: string, value: string) => {
    if (!id) return;
    const updates: any = { [field]: value || null };
    if (field === 'first_name' || field === 'last_name') {
      const first = field === 'first_name' ? value : contact?.first_name || '';
      const last = field === 'last_name' ? value : contact?.last_name || '';
      updates.full_name = `${first} ${last}`.trim() || null;
    }
    const { error } = await supabase.from('contacts').update(updates).eq('id', id);
    if (error) { toast.error('Failed to update'); return; }
    invalidatePersonScope(queryClient);
  };

  const handleSaveNote = async () => {
    if (!noteText.trim() || !id) return;
    setSavingNote(true);
    const { error } = await supabase.from('notes').insert({
      entity_id: id,
      entity_type: 'contact',
      note: noteText.trim(),
    });
    if (error) toast.error('Failed to save note');
    else {
      toast.success('Note saved');
      setNoteText('');
      invalidateNoteScope(queryClient);
    }
    setSavingNote(false);
  };

  const generateJoeSays = async () => {
    if (!id) return;
    setGeneratingJoe(true);
    try {
      const res = await fetch('/api/trigger-generate-joe-says', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: id, entityType: 'contact' }),
      });
      const data = await res.json();
      if (!data.triggered) throw new Error(data.error || 'Failed to trigger');
      toast.success('Joe Says generation started — will update shortly');
      setTimeout(() => { queryClient.invalidateQueries({ queryKey: ['contact', id] }); }, 8000);
      setTimeout(() => { queryClient.invalidateQueries({ queryKey: ['contact', id] }); }, 15000);
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate');
    } finally {
      setGeneratingJoe(false);
    }
  };

  const handleJoeChatSend = async () => {
    if (!joeChatInput.trim() || joeChatLoading) return;
    const userMsg = { role: 'user' as const, content: joeChatInput };
    const allMessages = [...joeChatMessages, userMsg];
    setJoeChatMessages(allMessages);
    setJoeChatInput('');
    setJoeChatLoading(true);

    const cName = (contact as any).company_name || (contact as any).companies?.name || '';
    const contextMsg = contact
      ? `[Context: You're discussing contact ${contact.full_name || `${contact.first_name} ${contact.last_name}`}, ${contact.title || ''} at ${cName}. Contact ID: ${id}]`
      : '';

    let assistantSoFar = '';
    try {
      const apiMessages = [
        ...(contextMsg ? [{ role: 'user', content: contextMsg }, { role: 'assistant', content: 'Got it — I have this contact pulled up. What do you need?' }] : []),
        ...allMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
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

  /* ---- loading / not found ---- */

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </MainLayout>
    );
  }

  if (!contact) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Contact not found.</p>
        </div>
      </MainLayout>
    );
  }

  const c = contact as any;
  const initials = `${contact.first_name?.[0] ?? ''}${contact.last_name?.[0] ?? ''}`;
  const fullName = contact.full_name ?? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim();
  const companyName = c.company_name || c.companies?.name || '';
  const statusCfg = CONTACT_STATUSES[contact.status ?? ''] ?? CONTACT_STATUSES.active;

  /* ---- sidebar filtering ---- */

  const filteredNotes = (notes as any[]).filter((n: any) => {
    if (sidebarSearch) {
      const text = (n.note || '').toLowerCase();
      if (!text.includes(sidebarSearch.toLowerCase())) return false;
    }
    return true;
  });

  const filteredConversations = (conversations as any[]).filter((conv: any) => {
    if (commFilter !== 'all' && conv.channel !== commFilter) return false;
    return true;
  });

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  return (
    <MainLayout>
      {/* Top header bar */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {c.avatar_url ? (
          <img src={c.avatar_url} alt={fullName} className="h-10 w-10 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent shrink-0">
            {initials}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground truncate">{fullName}</h1>
            <Badge variant="secondary" className={cn('text-xs border shrink-0', statusCfg.className)}>
              {statusCfg.label}
            </Badge>
            {Array.isArray(c.roles) && c.roles.includes('client') && (
              <Badge variant="secondary" className="text-xs bg-accent/15 text-accent border-accent/30 shrink-0">Client</Badge>
            )}
            {Array.isArray(c.roles) && c.roles.includes('candidate') && (
              <Badge variant="secondary" className="text-xs bg-green-500/10 text-green-600 border-green-500/20 shrink-0">Candidate</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {contact.title ?? ''}{contact.title && companyName ? ' at ' : ''}{companyName}
          </p>
        </div>

        {/* Social / contact links */}
        <div className="flex items-center gap-1.5 shrink-0">
          {(() => {
            // Prefer work_email for client outreach (sequences send to
            // work_email; personal_email is shown for context). Fall back to
            // the legacy email column during the migration off it.
            const mailto = (contact as any).work_email || (contact as any).personal_email || contact.email;
            return mailto ? (
              <a href={`mailto:${mailto}`} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={mailto}>
                <Mail className="h-4 w-4" />
              </a>
            ) : null;
          })()}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={contact.phone}>
              <Phone className="h-4 w-4" />
            </a>
          )}
          {contact.linkedin_url && (
            <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="LinkedIn Profile">
              <Linkedin className="h-4 w-4" />
            </a>
          )}
          <button
            onClick={() => setScheduleMeetingOpen(true)}
            className="p-2 rounded-lg hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors"
            title="Schedule meeting"
          >
            <CalendarPlus className="h-4 w-4" />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-2 rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
            title="Delete contact"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ScheduleMeetingDialog
        open={scheduleMeetingOpen}
        onOpenChange={setScheduleMeetingOpen}
        attendee={{
          id: contact.id,
          type: 'contact',
          name: contact.full_name || `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() || 'Contact',
          email: (contact as any).work_email ?? (contact as any).personal_email ?? (contact as any).email ?? null,
        }}
        defaultSubject={`Meeting w/ ${contact.full_name || contact.first_name || 'contact'}`}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <span className="font-semibold">{contact.first_name} {contact.last_name}</span> and all associated send-outs, notes, and job links. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingContact}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteContact} disabled={deletingContact} className="bg-red-600 hover:bg-red-700">
              {deletingContact ? 'Deleting…' : 'Delete contact'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Main content: left panel + right sidebar */}
      <div className="flex flex-1 overflow-hidden bg-page-bg">

        {/* ============ LEFT PANEL (70-75%) ============ */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ flex: '3 1 0%' }}>

          {/* Contact info section */}
          <div className="px-8 py-5 border-b border-border">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
              <EditableField label="First Name" value={contact.first_name} onSave={v => updateField('first_name', v)} placeholder="First name" />
              <EditableField label="Last Name" value={contact.last_name} onSave={v => updateField('last_name', v)} placeholder="Last name" />
              <EditableField label="Title" value={contact.title} onSave={v => updateField('title', v)} placeholder="e.g. VP, Talent Acquisition" />
              <EditableField label="Phone" value={contact.phone} onSave={v => updateField('phone', v)} placeholder="+1 (555) 000-0000" />
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <EditableField label="Company" value={companyName} onSave={v => updateField('company_name', v)} placeholder="Company name" />
                </div>
                {(c as any).company_id && (
                  <button
                    onClick={() => navigate(`/companies/${(c as any).company_id}`)}
                    title="View company"
                    className="shrink-0 mb-1 p-1.5 rounded hover:bg-emerald-light text-muted-foreground hover:text-emerald transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <EditableField label="LinkedIn URL" value={contact.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/in/..." />
              <EditableField label="Address" value={c.address} onSave={v => updateField('address', v)} placeholder="Street address" />
              <EditableField label="City" value={c.city} onSave={v => updateField('city', v)} placeholder="City" />
              <EditableField label="State" value={c.state} onSave={v => updateField('state', v)} placeholder="State / Province" />
              <EditableField label="Country" value={c.country} onSave={v => updateField('country', v)} placeholder="Country" />
              <EditableField label="Postal Code" value={c.postal_code} onSave={v => updateField('postal_code', v)} placeholder="Zip / Postal code" />
              <EditableField
                label="Work Email"
                value={c.work_email}
                onSave={v => updateField('work_email', v)}
                type="email"
                placeholder="work@firm.com"
              />
              <EditableField
                label="Personal Email"
                value={c.personal_email}
                onSave={v => updateField('personal_email', v)}
                type="email"
                placeholder="personal@gmail.com"
              />
              <EditableField
                label="Mobile Phone"
                value={c.mobile_phone}
                onSave={async v => {
                  await updateField('mobile_phone', v);
                  if (v) await updateField('phone', v);
                }}
                placeholder="+1 (212) 555-0000"
              />
            </div>

            {/* Timestamps */}
            <div className="flex items-center gap-6 mt-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> Last Contacted: {c.last_contacted_at ? format(new Date(c.last_contacted_at), 'MMM d, yyyy') : '\u2014'}
              </span>
              <span className="flex items-center gap-1">
                <Send className="h-3 w-3" /> Last Reached Out: {c.last_reached_out_at ? format(new Date(c.last_reached_out_at), 'MMM d, yyyy') : '\u2014'}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> Last Response: {c.last_responded_at ? format(new Date(c.last_responded_at), 'MMM d, yyyy') : '\u2014'}
              </span>
              <span>Created {format(new Date(contact.created_at), 'MMM d, yyyy')}</span>
            </div>
          </div>

          {/* ---- Tabs ---- */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-3 border-b border-border">
              <TabsList className="bg-white border border-card-border">
                <TabsTrigger value="joe" className="gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" /> Joe Says
                </TabsTrigger>
                <TabsTrigger value="jobs" className="gap-1.5">
                  <Briefcase className="h-3.5 w-3.5" /> Jobs ({linkedJobs.length})
                </TabsTrigger>
                <TabsTrigger value="candidates" className="gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Send Outs ({sendOuts.length})
                </TabsTrigger>
                <TabsTrigger value="communications" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> Communications ({(conversations as any[]).length})
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5">
                  <History className="h-3.5 w-3.5" /> Activity
                </TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Notes
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              {/* ---------- JOE SAYS TAB ---------- */}
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
                    <span className="text-sm">Joe is analyzing this contact...</span>
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
                    <p className="text-xs text-muted-foreground mb-4">AI brief using notes, communications, and contact history.</p>
                    <Button variant="gold" size="sm" onClick={generateJoeSays}>
                      <Sparkles className="h-3.5 w-3.5 mr-1" /> Generate Joe Says
                    </Button>
                  </div>
                )}

                {/* ── Ask Joe Chat ───────────────────────────────────────── */}
                <div className="mt-6 rounded-xl border border-border">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30 rounded-t-xl">
                    <Martini className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold">Ask Joe about this contact</h3>
                  </div>
                  <div ref={joeChatScrollRef} className="h-64 overflow-y-auto p-4 space-y-3">
                    {joeChatMessages.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">Ask Joe anything — draft outreach, get relationship context, meeting prep...</p>
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
                        placeholder="Ask Joe anything about this contact..."
                        disabled={joeChatLoading}
                        className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      />
                      <Button size="icon" variant="gold" onClick={handleJoeChatSend} disabled={joeChatLoading}>
                        <SendIcon className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* ---------- JOBS TAB ---------- */}
              <TabsContent value="jobs" className="px-8 py-5 mt-0 space-y-5">

                {/* Linked jobs list */}
                {linkedJobs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No linked jobs</p>
                    <p className="text-xs text-muted-foreground">Link a job below, or jobs connected via send-outs will appear here automatically.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {linkedJobs.map((job: any) => {
                      const isManualLink = !!(job as any)._job_contact_id;
                      return (
                        <div
                          key={job.id}
                          className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-all"
                        >
                          <button
                            onClick={() => navigate(`/jobs/${job.id}`)}
                            className="flex-1 text-left min-w-0"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground truncate">{job.title}</p>
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                  <Building className="h-3 w-3" /> {job.company_name || '\u2014'}
                                  {job.location && <><MapPin className="h-3 w-3 ml-2" /> {job.location}</>}
                                </p>
                              </div>
                              <Badge variant="secondary" className="text-[10px] shrink-0">
                                {job.status ?? 'unknown'}
                              </Badge>
                            </div>
                          </button>
                          {isManualLink && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                              onClick={() => unlinkJob(job.id)}
                              disabled={removingJobId === job.id}
                            >
                              {removingJobId === job.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <X className="h-3.5 w-3.5" />}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Add job */}
                <div className="border-t border-border pt-4 space-y-3">
                  <Label className="text-sm font-medium">Link a Job</Label>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 relative">
                      {selectedJobId ? (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                          <span className="flex-1 truncate">
                            {(() => {
                              const j = (allJobs as any[]).find((j: any) => j.id === selectedJobId);
                              return j ? `${j.title}${j.company_name ? ` — ${j.company_name}` : ''}` : 'Selected';
                            })()}
                          </span>
                          <button onClick={() => { setSelectedJobId(''); setJobSearch(''); }} className="text-muted-foreground hover:text-foreground">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                          <Input
                            className="pl-8 h-9 text-sm"
                            placeholder="Search jobs…"
                            value={jobSearch}
                            onChange={e => { setJobSearch(e.target.value); setJobSearchOpen(true); }}
                            onFocus={() => setJobSearchOpen(true)}
                            onBlur={() => setTimeout(() => setJobSearchOpen(false), 150)}
                          />
                          {jobSearchOpen && (
                            <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-card text-foreground shadow-md max-h-56 overflow-y-auto">
                              {(() => {
                                const linkedIds = new Set(linkedJobs.map((j: any) => j.id));
                                const q = jobSearch.toLowerCase();
                                const filtered = (allJobs as any[]).filter((j: any) =>
                                  !linkedIds.has(j.id) &&
                                  (!q || j.title?.toLowerCase().includes(q) || j.company_name?.toLowerCase().includes(q))
                                );
                                if (filtered.length === 0) return (
                                  <div className="px-3 py-3 text-sm text-muted-foreground">No jobs found</div>
                                );
                                return filtered.map((j: any) => (
                                  <button
                                    key={j.id}
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 flex flex-col"
                                    onMouseDown={() => { setSelectedJobId(j.id); setJobSearch(''); setJobSearchOpen(false); }}
                                  >
                                    <span className="font-medium text-foreground">{j.title}</span>
                                    {j.company_name && <span className="text-xs text-muted-foreground">{j.company_name}</span>}
                                  </button>
                                ));
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="gold"
                      onClick={linkJob}
                      disabled={!selectedJobId || linkingJob}
                    >
                      {linkingJob && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                      Add
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* ---------- CANDIDATES PITCHED TAB ---------- */}
              <TabsContent value="candidates" className="px-8 py-5 mt-0">
                {sendOuts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No candidates pitched</p>
                    <p className="text-xs text-muted-foreground">Candidates sent out to this contact will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sendOuts.map((so: any) => {
                      const cand = so.candidate ?? so.candidates;
                      const job = so.jobs;
                      const candName = cand?.full_name || `${cand?.first_name ?? ''} ${cand?.last_name ?? ''}`.trim() || 'Unknown';
                      return (
                        <div
                          key={so.id}
                          className="rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-all"
                        >
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => cand?.id && navigate(`/candidates/${cand.id}`)}
                                  className="text-sm font-medium text-foreground hover:text-accent transition-colors truncate"
                                >
                                  {candName}
                                </button>
                                {so.stage && (
                                  <Badge variant="secondary" className="text-[10px] shrink-0">{so.stage.replace(/_/g, ' ')}</Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {cand?.current_title ?? ''}{cand?.current_title && cand?.current_company ? ' at ' : ''}{cand?.current_company ?? ''}
                              </p>
                              {job && (
                                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                                  <Briefcase className="h-3 w-3" /> {job.title}{job.company_name ? ` \u2014 ${job.company_name}` : ''}
                                </p>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0 ml-3">
                              {so.created_at ? format(new Date(so.created_at), 'MMM d, yyyy') : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              {/* ---------- COMMUNICATIONS TAB ---------- */}
              <TabsContent value="communications" className="px-8 py-5 mt-0">
                <div className="flex items-center gap-2 mb-5">
                  <Button variant={commFilter === 'all' ? 'secondary' : 'outline'} size="sm" onClick={() => setCommFilter('all')}>All</Button>
                  <Button variant={commFilter === 'email' ? 'secondary' : 'outline'} size="sm" onClick={() => setCommFilter('email')}>
                    <Mail className="h-3.5 w-3.5 mr-1" /> Email
                  </Button>
                  <Button variant={commFilter === 'linkedin' ? 'secondary' : 'outline'} size="sm" onClick={() => setCommFilter('linkedin')}>
                    <Linkedin className="h-3.5 w-3.5 mr-1" /> LinkedIn
                  </Button>
                  <Button variant={commFilter === 'sms' ? 'secondary' : 'outline'} size="sm" onClick={() => setCommFilter('sms')}>
                    <MessageSquare className="h-3.5 w-3.5 mr-1" /> SMS
                  </Button>
                </div>

                {filteredConversations.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No communications yet</p>
                    <p className="text-xs text-muted-foreground">Email, LinkedIn, and SMS conversations will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredConversations.map((conv: any) => {
                      const channelLabel = COMM_CHANNEL_LABELS[conv.channel] || conv.channel || 'Unknown';
                      const messages = (conv.messages || []).sort(
                        (a: any, b: any) => new Date(a.sent_at || a.created_at).getTime() - new Date(b.sent_at || b.created_at).getTime()
                      );
                      return (
                        <Collapsible key={conv.id}>
                          <div className="rounded-lg border border-border hover:border-accent/40 transition-all">
                            <CollapsibleTrigger className="w-full text-left p-4 hover:bg-muted/30 transition-colors">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {conv.channel === 'email' && <Mail className="h-3.5 w-3.5 text-muted-foreground" />}
                                  {(conv.channel === 'linkedin' || conv.channel?.startsWith('linkedin')) && <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />}
                                  {conv.channel === 'sms' && <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
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

              {/* ---------- ACTIVITY TAB ---------- */}
              <TabsContent value="activity" className="px-8 py-5 mt-0">
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
                    const ch = conv.channel || '';
                    const chLabel = ch === 'linkedin' || ch.startsWith('linkedin') ? 'LinkedIn' : ch.charAt(0).toUpperCase() + ch.slice(1);
                    events.push({
                      date: conv.last_message_at,
                      icon: ch === 'email' ? <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                        : (ch === 'linkedin' || ch.startsWith('linkedin')) ? <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />
                        : ch === 'phone' ? <PhoneCall className="h-3.5 w-3.5 text-muted-foreground" />
                        : <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />,
                      title: `${chLabel} conversation`,
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
                  (sendOuts as any[]).forEach((s) => {
                    events.push({
                      date: s.created_at,
                      icon: <Briefcase className="h-3.5 w-3.5 text-accent" />,
                      title: `Candidate pitched: ${s.candidates?.full_name || s.candidates?.first_name || 'Unknown'}`,
                      detail: `${(s.jobs as any)?.title || 'Job'} — Stage: ${s.stage || '\u2014'}`,
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
                                {ev.date ? format(new Date(ev.date), 'MMM d, yyyy h:mm a') : '\u2014'}
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

              <TabsContent value="notes" className="px-8 py-5 mt-0">
                <EntityNotesTab entityType="contact" entityId={id!} placeholder="Add a note about this contact — call summary, hiring preferences, anything the team should see…" />
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

              {/* TASKS section (shown on all, tasks tabs) */}
              {(sidebarTab === 'all' || sidebarTab === 'tasks') && id && (
                <div>
                  {sidebarTab === 'all' && <div className="border-t border-border my-3" />}
                  <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 mb-3">
                    <FileText className="h-3 w-3" /> Tasks
                  </h3>
                  <p className="text-xs text-muted-foreground">No tasks yet.</p>
                </div>
              )}

              {/* MEETINGS section (shown on all, meetings tabs) */}
              {(sidebarTab === 'all' || sidebarTab === 'meetings') && (
                <div>
                  {sidebarTab === 'all' && <div className="border-t border-border my-3" />}
                  <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 mb-3">
                    <Calendar className="h-3 w-3" /> Meetings
                  </h3>
                  <p className="text-xs text-muted-foreground">No meetings scheduled.</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </MainLayout>
  );
};

export default ContactDetail;
