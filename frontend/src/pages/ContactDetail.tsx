import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TaskSidebar } from '@/components/tasks/TaskSidebar';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

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
        .select('*, candidates(id, full_name, first_name, last_name, current_title, current_company, email, phone, status), jobs(id, title, company_name, location, status)')
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

      // Merge and deduplicate
      const allJobs = [...(hiringManagerJobs || []), ...soJobs];
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

  // Local state
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [activeTab, setActiveTab] = useState('jobs');
  const [sidebarTab, setSidebarTab] = useState<'all' | 'notes' | 'tasks' | 'meetings'>('all');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [commFilter, setCommFilter] = useState<'all' | 'email' | 'linkedin' | 'sms'>('all');

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
    queryClient.invalidateQueries({ queryKey: ['contact', id] });
    queryClient.invalidateQueries({ queryKey: ['contacts'] });
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
      queryClient.invalidateQueries({ queryKey: ['notes', 'contact', id] });
    }
    setSavingNote(false);
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
        <Button variant="ghost" size="icon" onClick={() => navigate('/contacts')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground truncate">{fullName}</h1>
            <Badge variant="secondary" className={cn('text-xs border shrink-0', statusCfg.className)}>
              {statusCfg.label}
            </Badge>
            {c.is_client && (
              <Badge variant="secondary" className="text-xs bg-accent/15 text-accent border-accent/30 shrink-0">Client</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {contact.title ?? ''}{contact.title && companyName ? ' at ' : ''}{companyName}
          </p>
        </div>

        {/* Social / contact links */}
        <div className="flex items-center gap-1.5 shrink-0">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={contact.email}>
              <Mail className="h-4 w-4" />
            </a>
          )}
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
        </div>
      </div>

      {/* Main content: left panel + right sidebar */}
      <div className="flex flex-1 overflow-hidden">

        {/* ============ LEFT PANEL (70-75%) ============ */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ flex: '3 1 0%' }}>

          {/* Contact info section */}
          <div className="px-8 py-5 border-b border-border">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
              <EditableField label="First Name" value={contact.first_name} onSave={v => updateField('first_name', v)} placeholder="First name" />
              <EditableField label="Last Name" value={contact.last_name} onSave={v => updateField('last_name', v)} placeholder="Last name" />
              <EditableField label="Title" value={contact.title} onSave={v => updateField('title', v)} placeholder="e.g. VP, Talent Acquisition" />
              <EditableField label="Email" value={contact.email} onSave={v => updateField('email', v)} type="email" placeholder="email@domain.com" />
              <EditableField label="Phone" value={contact.phone} onSave={v => updateField('phone', v)} placeholder="+1 (555) 000-0000" />
              <EditableField label="Company" value={companyName} onSave={v => updateField('company_name', v)} placeholder="Company name" />
              <EditableField label="LinkedIn URL" value={contact.linkedin_url} onSave={v => updateField('linkedin_url', v)} placeholder="https://linkedin.com/in/..." />
              <EditableField label="Address" value={c.address} onSave={v => updateField('address', v)} placeholder="Street address" />
              <EditableField label="City" value={c.city} onSave={v => updateField('city', v)} placeholder="City" />
              <EditableField label="State" value={c.state} onSave={v => updateField('state', v)} placeholder="State / Province" />
              <EditableField label="Country" value={c.country} onSave={v => updateField('country', v)} placeholder="Country" />
              <EditableField label="Postal Code" value={c.postal_code} onSave={v => updateField('postal_code', v)} placeholder="Zip / Postal code" />
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
              <TabsList className="bg-secondary">
                <TabsTrigger value="jobs" className="gap-1.5">
                  <Briefcase className="h-3.5 w-3.5" /> Jobs ({linkedJobs.length})
                </TabsTrigger>
                <TabsTrigger value="candidates" className="gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Candidates Pitched ({sendOuts.length})
                </TabsTrigger>
                <TabsTrigger value="communications" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> Communications ({(conversations as any[]).length})
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              {/* ---------- JOBS TAB ---------- */}
              <TabsContent value="jobs" className="px-8 py-5 mt-0">
                {linkedJobs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium mb-1">No linked jobs</p>
                    <p className="text-xs text-muted-foreground">Jobs where this contact is the hiring manager or connected via send-outs will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {linkedJobs.map((job: any) => (
                      <button
                        key={job.id}
                        onClick={() => navigate(`/jobs/${job.id}`)}
                        className="w-full text-left rounded-lg border border-border bg-secondary/30 p-4 hover:border-accent/40 transition-all"
                      >
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{job.title}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Building className="h-3 w-3" /> {job.company_name || '\u2014'}
                              {job.location && <><MapPin className="h-3 w-3 ml-2" /> {job.location}</>}
                            </p>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0 ml-3">
                            {job.status ?? 'unknown'}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
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
                      const cand = so.candidates;
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
                                {so.status && (
                                  <Badge variant="secondary" className="text-[10px] shrink-0">{so.status}</Badge>
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
                        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                      );
                      const latestMsg = messages[0];
                      return (
                        <div key={conv.id} className="rounded-lg border border-border p-4 hover:border-accent/40 transition-all">
                          <div className="flex items-center justify-between mb-1.5">
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
                          {conv.subject && <p className="text-sm mb-0.5">{conv.subject}</p>}
                          {(conv.last_message_preview || latestMsg?.body) && (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {conv.last_message_preview || latestMsg?.body?.slice(0, 200)}
                            </p>
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
                  <TaskSidebar entityType="contact" entityId={id} />
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
