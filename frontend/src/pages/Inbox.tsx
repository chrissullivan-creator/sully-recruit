import { useState, useEffect, useRef } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Target, Send, Loader2, MoreVertical,
  ChevronRight, Circle, CheckCircle2, AlertCircle, MapPin,
  Building, Link as LinkIcon, UserPlus, ArrowLeft, ArrowRight,
  PenSquare, Plus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ComposeMessageDialog } from '@/components/inbox/ComposeMessageDialog';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { TemplatePickerPopover } from '@/components/templates/TemplatePickerPopover';

// ---------- Types ----------
interface InboxThread {
  id: string;
  channel: string;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  is_read: boolean;
  is_archived: boolean;
  candidate_id: string | null;
  candidate_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  send_out_id: string | null;
  account_id: string | null;
}

interface Message {
  id: string;
  conversation_id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  received_at: string | null;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address: string | null;
  created_at: string;
  candidate_id: string;
  contact_id: string | null;
}

// ---------- Constants ----------
const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  sms: MessageSquare,
  linkedin: Linkedin,
  phone: Phone,
  call: Phone,
};
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  phone: 'Phone',
  call: 'Call',
};
const CHANNEL_COLORS: Record<string, string> = {
  email: 'bg-info/10 text-info',
  linkedin: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  sms: 'bg-success/10 text-success',
  phone: 'bg-accent/10 text-accent',
  call: 'bg-[#C9A84C]/10 text-[#C9A84C]',
};

// ---------- Thread Item ----------
function ThreadItem({
  thread,
  isSelected,
  onClick,
}: {
  thread: InboxThread;
  isSelected: boolean;
  onClick: () => void;
}) {
  const Icon = CHANNEL_ICONS[thread.channel] || Mail;
  const entityName = thread.candidate_name || thread.contact_name;
  const isLinked = !!(thread.candidate_id || thread.contact_id);

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3.5 border-b border-border/60 hover:bg-muted/40 transition-colors relative',
        isSelected && 'bg-accent/8 border-l-2 border-l-accent',
        !thread.is_read && !isSelected && 'bg-muted/20'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', CHANNEL_COLORS[thread.channel] || 'bg-muted text-muted-foreground')}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {entityName ? (
                <span className={cn('text-sm truncate', !thread.is_read ? 'font-semibold text-foreground' : 'font-medium text-foreground/90')}>
                  {entityName}
                </span>
              ) : (
                <span className="text-sm font-medium text-warning italic">Unlinked</span>
              )}
              {!thread.is_read && <Circle className="h-1.5 w-1.5 fill-accent text-accent shrink-0" />}
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {thread.last_message_at
                ? formatDistanceToNow(new Date(thread.last_message_at), { addSuffix: true })
                : ''}
            </span>
          </div>
          {thread.subject && (
            <p className={cn('text-xs truncate mb-0.5', !thread.is_read ? 'text-foreground/80 font-medium' : 'text-foreground/70')}>
              {thread.subject}
            </p>
          )}
          <p className="text-xs text-muted-foreground truncate">{thread.last_message_preview || '—'}</p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <Badge variant="outline" className="text-[9px] uppercase h-4 px-1.5 tracking-wide">
              {CHANNEL_LABELS[thread.channel] || thread.channel}
            </Badge>
            {!isLinked && (
              <Badge variant="outline" className="text-[9px] uppercase h-4 px-1.5 tracking-wide border-warning/40 text-warning">
                Unlinked
              </Badge>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ---------- Create Person Dialog ----------
function CreatePersonDialog({
  open,
  onOpenChange,
  threadId,
  defaultType,
  prefill,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  defaultType: 'candidate' | 'contact';
  prefill: { name: string; address: string };
  channel: string;
}) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<'candidate' | 'contact'>(defaultType);
  const nameParts = prefill.name.split(' ');
  const isEmail = prefill.address.includes('@');
  const [form, setForm] = useState({
    first_name: nameParts[0] || '',
    last_name: nameParts.slice(1).join(' ') || '',
    email: isEmail ? prefill.address : '',
    phone: '',
    linkedin_url: channel === 'linkedin' ? prefill.address : '',
    title: '',
    company: '',
    location: '',
  });
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolvedRef = useRef(false);

  // Auto-resolve Unipile profile when dialog opens for LinkedIn senders
  useEffect(() => {
    if (!open || resolvedRef.current) return;
    if (channel !== 'linkedin') return;

    const slug = prefill.address;
    if (!slug) return;

    resolvedRef.current = true;
    setResolving(true);

    (async () => {
      try {
        // Get Chris's Unipile account for resolution
        const { data: chrisAcct } = await supabase
          .from('integration_accounts')
          .select('unipile_account_id')
          .ilike('account_label', '%Chris Sullivan%')
          .eq('is_active', true)
          .maybeSingle();

        const accountId = chrisAcct?.unipile_account_id;
        if (!accountId) {
          console.warn('No Unipile account found for Chris — skipping profile resolution');
          return;
        }

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

        // Try resolve-unipile-id for the sender's LinkedIn slug
        const resp = await fetch(`${supabaseUrl}/functions/v1/resolve-unipile-id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: supabaseKey },
          body: JSON.stringify({ linkedin_slug: slug, account_id: accountId }),
        });

        if (resp.ok) {
          const profile = await resp.json();
          // Also try getting full profile data from Unipile
          const { data: unipileCfg } = await supabase
            .from('user_integrations')
            .select('config')
            .eq('integration_type', 'unipile')
            .limit(1)
            .maybeSingle();

          const cfg = unipileCfg?.config as any;
          let fullProfile: any = null;

          if (cfg?.api_key && cfg?.base_url && (profile.unipile_id || slug)) {
            try {
              const profileResp = await fetch(
                `${cfg.base_url.replace(/\/+$/, '')}/api/v1/users/${profile.unipile_id || slug}` +
                (accountId ? `?account_id=${accountId}` : ''),
                {
                  headers: {
                    'X-API-KEY': cfg.api_key,
                    'Accept': 'application/json',
                  },
                }
              );
              if (profileResp.ok) {
                fullProfile = await profileResp.json();
              }
            } catch (e) {
              console.warn('Full profile fetch failed:', e);
            }
          }

          // Prefill from resolved data
          setForm(prev => ({
            ...prev,
            first_name: fullProfile?.first_name || profile.name?.split(' ')[0] || prev.first_name,
            last_name: fullProfile?.last_name || profile.name?.split(' ').slice(1).join(' ') || prev.last_name,
            title: fullProfile?.headline || fullProfile?.title || fullProfile?.current_title || prev.title,
            company: fullProfile?.company || fullProfile?.current_company || fullProfile?.company_name || prev.company,
            location: fullProfile?.location || fullProfile?.region || prev.location,
            linkedin_url: fullProfile?.public_profile_url || fullProfile?.linkedin_url || (slug.startsWith('http') ? slug : `https://linkedin.com/in/${slug}`),
            email: fullProfile?.email || prev.email,
            phone: fullProfile?.phone || fullProfile?.phone_number || prev.phone,
          }));
        }
      } catch (err) {
        console.warn('Unipile profile resolution failed:', err);
      } finally {
        setResolving(false);
      }
    })();
  }, [open, channel, prefill.address]);

  // Reset form when dialog opens with new prefill
  const resetForm = () => {
    const parts = prefill.name.split(' ');
    const emailAddr = prefill.address.includes('@');
    resolvedRef.current = false;
    setForm({
      first_name: parts[0] || '',
      last_name: parts.slice(1).join(' ') || '',
      email: emailAddr ? prefill.address : '',
      phone: '',
      linkedin_url: channel === 'linkedin' ? prefill.address : '',
      title: '',
      company: '',
      location: '',
    });
    setType(defaultType);
  };

  const handleCreate = async () => {
    if (!form.first_name.trim() && !form.last_name.trim()) {
      toast.error('Name is required');
      return;
    }
    setCreating(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;

      if (type === 'candidate') {
        const { data: newRecord, error } = await supabase.from('candidates').insert({
          first_name: form.first_name.trim() || null,
          last_name: form.last_name.trim() || null,
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          linkedin_url: form.linkedin_url.trim() || null,
          current_title: form.title.trim() || null,
          current_company: form.company.trim() || null,
          location: form.location.trim() || null,
          status: 'new',
          owner_id: userId,
        } as any).select('id, full_name').single();
        if (error) throw error;

        // Auto-link conversation
        const { error: linkErr } = await supabase.from('conversations').update({ candidate_id: newRecord.id } as any).eq('id', threadId);
        if (linkErr) throw linkErr;
        toast.success(`Candidate "${newRecord.full_name || form.first_name}" created & linked`);
      } else {
        const { data: newRecord, error } = await supabase.from('contacts').insert({
          first_name: form.first_name.trim() || null,
          last_name: form.last_name.trim() || null,
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          linkedin_url: form.linkedin_url.trim() || null,
          title: form.title.trim() || null,
          status: 'active',
          owner_id: userId,
        } as any).select('id, full_name').single();
        if (error) throw error;

        const { error: linkErr } = await supabase.from('conversations').update({ contact_id: newRecord.id } as any).eq('id', threadId);
        if (linkErr) throw linkErr;
        toast.success(`Contact "${newRecord.full_name || form.first_name}" created & linked`);
      }

      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create record');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add New {type === 'candidate' ? 'Candidate' : 'Contact'}
          </DialogTitle>
          <DialogDescription>
            Create a new record and automatically link this conversation to it.
          </DialogDescription>
        </DialogHeader>

        {resolving && (
          <div className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs text-info">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Resolving LinkedIn profile via Recruiter…
          </div>
        )}

        <div className="space-y-4 py-2">
          {/* Type toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setType('candidate')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                type === 'candidate'
                  ? 'bg-success/10 text-success border-success/30'
                  : 'border-border text-muted-foreground hover:border-success/30 hover:text-foreground'
              )}
            >
              <UserCheck className="h-4 w-4" />
              Candidate
            </button>
            <button
              onClick={() => setType('contact')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                type === 'contact'
                  ? 'bg-info/10 text-info border-info/30'
                  : 'border-border text-muted-foreground hover:border-info/30 hover:text-foreground'
              )}
            >
              <Users className="h-4 w-4" />
              Contact
            </button>
          </div>

          {/* Form fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">First Name</Label>
              <Input
                value={form.first_name}
                onChange={(e) => setForm(f => ({ ...f, first_name: e.target.value }))}
                placeholder="First name"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Last Name</Label>
              <Input
                value={form.last_name}
                onChange={(e) => setForm(f => ({ ...f, last_name: e.target.value }))}
                placeholder="Last name"
                className="h-9"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input
                value={form.email}
                onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="Phone number"
                className="h-9"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{type === 'candidate' ? 'Current Title' : 'Job Title'}</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Job title"
              className="h-9"
            />
          </div>

          {type === 'candidate' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Current Company</Label>
                <Input
                  value={form.company}
                  onChange={(e) => setForm(f => ({ ...f, company: e.target.value }))}
                  placeholder="Company name"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Location</Label>
                <Input
                  value={form.location}
                  onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))}
                  placeholder="City, State"
                  className="h-9"
                />
              </div>
            </div>
          )}

          {channel === 'linkedin' && (
            <div className="space-y-1.5">
              <Label className="text-xs">LinkedIn URL</Label>
              <Input
                value={form.linkedin_url}
                onChange={(e) => setForm(f => ({ ...f, linkedin_url: e.target.value }))}
                placeholder="https://linkedin.com/in/..."
                className="h-9"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="gold"
            onClick={handleCreate}
            disabled={creating || resolving || (!form.first_name.trim() && !form.last_name.trim())}
            className="gap-1.5"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create & Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Entity Info Panel ----------
function EntityPanel({ thread, messages }: { thread: InboxThread | null; messages: Message[] }) {
  const queryClient = useQueryClient();
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState<any[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'candidate' | 'contact'>('candidate');

  const { data: candidate } = useQuery({
    queryKey: ['candidate', thread?.candidate_id],
    enabled: !!thread?.candidate_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('candidates').select('*').eq('id', thread!.candidate_id!).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: contact } = useQuery({
    queryKey: ['contact', thread?.contact_id],
    enabled: !!thread?.contact_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('contacts').select('*, companies(name)').eq('id', thread!.contact_id!).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: notes = [] } = useQuery({
    queryKey: ['notes', 'candidate', thread?.candidate_id],
    enabled: !!thread?.candidate_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('notes').select('*').eq('entity_id', thread!.candidate_id!).eq('entity_type', 'candidate').order('created_at', { ascending: false }).limit(5);
      if (error) throw error;
      return data;
    },
  });

  // Extract sender info from inbound messages for pre-filling create forms
  const firstInbound = messages.find(m => m.direction === 'inbound');
  const senderName = firstInbound?.sender_name || thread?.candidate_name || thread?.contact_name || '';
  const senderAddress = firstInbound?.sender_address || '';

  const handleSearch = async () => {
    if (!linkSearch.trim()) return;
    setLinkSearching(true);
    const q = linkSearch.trim();
    const [cRes, ctRes] = await Promise.all([
      supabase.from('candidates').select('id, full_name, email, current_title, current_company').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(5),
      supabase.from('contacts').select('id, full_name, email, title').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(5),
    ]);
    const results = [
      ...(cRes.data || []).map(r => ({ ...r, entity_type: 'candidate' })),
      ...(ctRes.data || []).map(r => ({ ...r, entity_type: 'contact' })),
    ];
    setLinkResults(results);
    setLinkSearching(false);
  };

  const handleLink = async (entityType: string, entityId: string, entityName: string) => {
    if (!thread) return;
    setLinking(true);
    const update: any = {};
    if (entityType === 'candidate') update.candidate_id = entityId;
    if (entityType === 'contact') update.contact_id = entityId;

    const { error } = await supabase.from('conversations').update(update).eq('id', thread.id);
    if (error) {
      toast.error('Failed to link: ' + error.message);
    } else {
      toast.success(`Linked to ${entityName}`);
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      queryClient.invalidateQueries({ queryKey: ['inbox_thread', thread.id] });
      setLinkSearch('');
      setLinkResults([]);
    }
    setLinking(false);
  };

  if (!thread) return null;

  const entity = candidate || contact;
  const entityType = thread.candidate_id ? 'candidate' : thread.contact_id ? 'contact' : null;
  const isLinked = !!(thread.candidate_id || thread.contact_id);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-5 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          {isLinked ? 'Linked Record' : 'Link or Add Record'}
        </h3>

        {isLinked && entity ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
                {entity.full_name?.slice(0, 2).toUpperCase() || '??'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-foreground truncate">{entity.full_name}</p>
                  <Badge variant="outline" className="text-[9px] capitalize">{entityType}</Badge>
                </div>
                {(entity as any).current_title && <p className="text-xs text-muted-foreground truncate">{(entity as any).current_title}</p>}
                {(entity as any).title && <p className="text-xs text-muted-foreground truncate">{(entity as any).title}</p>}
              </div>
            </div>
            <div className="space-y-1.5">
              {entity.email && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{entity.email}</span>
                </div>
              )}
              {entity.phone && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{entity.phone}</span>
                </div>
              )}
              {entity.linkedin_url && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Linkedin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <a href={entity.linkedin_url} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate">LinkedIn Profile</a>
                </div>
              )}
              {(entity as any).current_company && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{(entity as any).current_company}</span>
                </div>
              )}
              {(entity as any).companies?.name && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{(entity as any).companies.name}</span>
                </div>
              )}
            </div>
            {entityType === 'candidate' && (
              <Link to={`/candidates/${thread.candidate_id}`}>
                <Button variant="outline" size="sm" className="w-full gap-1.5">
                  <UserCheck className="h-3.5 w-3.5" /> View Candidate <ArrowRight className="h-3 w-3 ml-auto" />
                </Button>
              </Link>
            )}
            {entityType === 'contact' && (
              <Link to={`/contacts`}>
                <Button variant="outline" size="sm" className="w-full gap-1.5">
                  <Users className="h-3.5 w-3.5" /> View Contact <ArrowRight className="h-3 w-3 ml-auto" />
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-warning">Unlinked conversation</p>
                <p className="text-[10px] text-warning/80 mt-0.5">
                  {senderName ? `From: ${senderName}` : 'Unknown sender'} via {CHANNEL_LABELS[thread.channel] || thread.channel}
                </p>
              </div>
            </div>

            {/* Search existing records */}
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Search existing</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Search name or email..."
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="h-8 text-xs"
                />
                <Button size="sm" variant="outline" onClick={handleSearch} disabled={linkSearching} className="h-8 px-2">
                  {linkSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            {linkResults.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                {linkResults.map((r) => (
                  <button
                    key={r.id + r.entity_type}
                    onClick={() => handleLink(r.entity_type, r.id, r.full_name)}
                    disabled={linking}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0 text-left"
                  >
                    {r.entity_type === 'candidate'
                      ? <UserCheck className="h-3.5 w-3.5 text-success shrink-0" />
                      : <Users className="h-3.5 w-3.5 text-info shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{r.full_name}</p>
                      <p className="text-[10px] text-muted-foreground truncate capitalize">
                        {r.entity_type} · {r.current_title || r.title || r.email || ''}
                      </p>
                    </div>
                    <LinkIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {/* Divider + Create New */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] text-muted-foreground">or create new</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setCreateType('candidate'); setCreateOpen(true); }}
                className="flex-1 gap-1.5 text-xs"
              >
                <UserPlus className="h-3.5 w-3.5 text-success" />
                Add Candidate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setCreateType('contact'); setCreateOpen(true); }}
                className="flex-1 gap-1.5 text-xs"
              >
                <UserPlus className="h-3.5 w-3.5 text-info" />
                Add Contact
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Recent notes */}
      {notes.length > 0 && (
        <div className="p-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Notes</h3>
          <div className="space-y-2">
            {notes.slice(0, 3).map((n: any) => (
              <div key={n.id} className="rounded-md border border-border bg-muted/20 p-3">
                <p className="text-xs text-foreground leading-relaxed">{n.note}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{format(new Date(n.created_at), 'MMM d, yyyy')}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Person Dialog */}
      <CreatePersonDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        threadId={thread.id}
        defaultType={createType}
        prefill={{ name: senderName, address: senderAddress }}
        channel={thread.channel}
      />
    </div>
  );
}

// ---------- Helpers ----------
function stripEmailThread(body: string): string {
  // Remove everything after "On ... wrote:" quote block
  const patterns = [
    /\r?\n\s*On .{10,80} wrote:\s*\r?\n[\s\S]*/,
    /\r?\n\s*----+ ?Original Message ?----+[\s\S]*/i,
    /\r?\n\s*From: .+[\s\S]*/,
    /\r?\n\s*>.*(\r?\n\s*>.*)*/,
  ];
  let result = body;
  for (const p of patterns) {
    const m = result.match(p);
    if (m && m.index !== undefined && m.index > 20) {
      result = result.slice(0, m.index).trimEnd();
      break;
    }
  }
  return result;
}

function getInitials(name: string | null | undefined): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------- Message Detail ----------
function MessagePane({ threadId }: { threadId: string | null }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [replyHtml, setReplyHtml] = useState('');
  const [sending, setSending] = useState(false);
  const [showEntity, setShowEntity] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogType, setCreateDialogType] = useState<'candidate' | 'contact'>('candidate');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const { data: thread, isLoading: threadLoading } = useQuery({
    queryKey: ['inbox_thread', threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('inbox_threads').select('*').eq('id', threadId!).single();
      if (error) throw error;
      return data as InboxThread;
    },
  });

  const { data: messages = [], isLoading: msgsLoading } = useQuery({
    queryKey: ['messages', threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages').select('*').eq('conversation_id', threadId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as Message[];
    },
  });

  // Auto-scroll to bottom on load and when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, threadId]);

  const handleMarkRead = async () => {
    if (!threadId || thread?.is_read) return;
    await supabase.from('conversations').update({ is_read: true }).eq('id', threadId);
    queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
    queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
  };

  const handleSend = async () => {
    const html = replyHtml || editorRef.current?.innerHTML || '';
    const text = replyText || editorRef.current?.textContent || '';
    if (!text.trim() || !threadId || !thread) return;
    setSending(true);
    try {
      // Determine recipient address based on channel
      let toAddress = '';
      // Find the most recent inbound message (has the sender's address)
      const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');

      if (thread.channel === 'email') {
        toAddress = lastInbound?.sender_address || '';
      } else if (thread.channel === 'sms') {
        toAddress = lastInbound?.sender_address || '';
      } else if (thread.channel === 'linkedin') {
        // Try candidate_channels first
        if (thread.candidate_id) {
          const { data: channelData } = await supabase
            .from('candidate_channels')
            .select('provider_id, unipile_id')
            .eq('candidate_id', thread.candidate_id)
            .eq('channel', 'linkedin')
            .maybeSingle();
          toAddress = channelData?.provider_id || channelData?.unipile_id || '';
        }
        // Try contact_channels
        if (!toAddress && thread.contact_id) {
          const { data: channelData } = await supabase
            .from('contact_channels')
            .select('provider_id, unipile_id')
            .eq('contact_id', thread.contact_id)
            .eq('channel', 'linkedin')
            .maybeSingle();
          toAddress = channelData?.provider_id || channelData?.unipile_id || '';
        }
        // Fall back to the inbound message sender address (works for unlinked too)
        if (!toAddress) {
          toAddress = lastInbound?.sender_address || '';
        }
      }

      // Determine which account to send from — use the thread's account_id (the account
      // that received the original message), falling back to looking up the recipient's
      // account from the original inbound message
      let sendAccountId = thread.account_id || '';
      if (!sendAccountId && thread.channel === 'linkedin') {
        // Try to find the account from the last inbound message's recipient_address
        const recipientAddr = lastInbound?.recipient_address;
        if (recipientAddr) {
          // recipient_address on inbound = the Unipile account that received it
          const { data: acct } = await supabase
            .from('integration_accounts')
            .select('unipile_account_id')
            .eq('unipile_account_id', recipientAddr)
            .eq('is_active', true)
            .maybeSingle();
          sendAccountId = acct?.unipile_account_id || '';
        }
      }

      if (!toAddress) {
        toast.error(`No recipient address found. The sender's address may be missing from the inbound message. Try linking this conversation to a candidate or contact first.`);
        setSending(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke('send-message', {
        body: {
          channel: thread.channel,
          conversation_id: threadId,
          candidate_id: thread.candidate_id,
          contact_id: thread.contact_id,
          to: toAddress,
          subject: thread.subject || undefined,
          body: thread.channel === 'email' ? html : text.trim(),
          account_id: sendAccountId || undefined,
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Send failed');

      toast.success(`Message sent via ${CHANNEL_LABELS[thread.channel] || thread.channel}`);
      setReplyText('');
      setReplyHtml('');
      if (editorRef.current) editorRef.current.innerHTML = '';
      queryClient.invalidateQueries({ queryKey: ['messages', threadId] });
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
    } catch (err: any) {
      console.error('Send error:', err);
      toast.error(err.message || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  if (!threadId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground select-none">
        <Mail className="h-16 w-16 mb-4 opacity-20" />
        <p className="text-sm font-medium">Select a conversation</p>
        <p className="text-xs mt-1 opacity-70">All your messages in one place</p>
      </div>
    );
  }

  if (threadLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">Conversation not found</p>
      </div>
    );
  }

  const Icon = CHANNEL_ICONS[thread.channel] || Mail;
  const entityName = thread.candidate_name || thread.contact_name;
  const isUnlinked = !(thread.candidate_id || thread.contact_id);

  // Sender info for create dialog prefill
  const firstInbound = messages.find(m => m.direction === 'inbound');
  const senderName = firstInbound?.sender_name || entityName || '';
  const senderAddress = firstInbound?.sender_address || '';

  // Group messages by date for date separators
  const getDateKey = (msg: Message) => {
    const d = msg.sent_at || msg.received_at || msg.created_at;
    return format(new Date(d), 'yyyy-MM-dd');
  };

  return (
    <div className="flex h-full">
      {/* Messages */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', CHANNEL_COLORS[thread.channel] || 'bg-muted text-muted-foreground')}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground truncate">
                {entityName || 'Unknown Sender'}
              </h2>
              <Badge variant="secondary" className="text-[10px] uppercase shrink-0">
                {CHANNEL_LABELS[thread.channel] || thread.channel}
              </Badge>
              {isUnlinked && (
                <Badge variant="outline" className="text-[9px] uppercase shrink-0 border-warning/40 text-warning">
                  Unlinked
                </Badge>
              )}
            </div>
            {thread.subject && (
              <p className="text-xs text-muted-foreground truncate">{thread.subject}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!thread.is_read && (
              <Button variant="ghost" size="sm" onClick={handleMarkRead} className="text-xs">
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Read
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowEntity((v) => !v)}
              title="Toggle contact panel"
              className={showEntity ? 'text-accent' : ''}
            >
              <Users className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Unlinked banner — prominent CTA to add candidate/contact */}
        {isUnlinked && (
          <div className="px-6 py-3 bg-warning/5 border-b border-warning/20 flex items-center gap-3">
            <AlertCircle className="h-4 w-4 text-warning shrink-0" />
            <p className="text-xs text-warning flex-1">
              <span className="font-medium">Not in your database.</span> Add this person as a candidate or contact to track them.
            </p>
            <div className="flex gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setCreateDialogType('candidate'); setCreateDialogOpen(true); }}
                className="h-7 text-xs gap-1 border-success/30 text-success hover:bg-success/10"
              >
                <UserPlus className="h-3 w-3" />
                Add Candidate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setCreateDialogType('contact'); setCreateDialogOpen(true); }}
                className="h-7 text-xs gap-1 border-info/30 text-info hover:bg-info/10"
              >
                <UserPlus className="h-3 w-3" />
                Add Contact
              </Button>
            </div>
          </div>
        )}

        {/* Messages scroll */}
        <ScrollArea className="flex-1">
          <div className="p-6">
          {msgsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground select-none">
              <div className="relative">
                <MessageSquare className="h-12 w-12 opacity-20 animate-pulse" />
              </div>
              <p className="text-sm font-medium mt-4">Conversation starting...</p>
              <p className="text-xs opacity-60 mt-1">Messages will appear here as they sync</p>
            </div>
          ) : (
            <div className="max-w-2xl mx-auto">
              {messages.map((msg, idx) => {
                const isOutbound = msg.direction === 'outbound';
                const isInbound = !isOutbound;
                const msgDate = getDateKey(msg);
                const prevDate = idx > 0 ? getDateKey(messages[idx - 1]) : null;
                const showDateSep = msgDate !== prevDate;
                const msgTime = msg.sent_at || msg.received_at || msg.created_at;

                // Grouping: same sender as previous message?
                const prevMsg = idx > 0 ? messages[idx - 1] : null;
                const sameSenderAsPrev = prevMsg && prevMsg.direction === msg.direction && !showDateSep;

                // Determine display body
                let displayBody = msg.body || '';
                if (!displayBody && msg.subject) displayBody = msg.subject;
                if (displayBody && thread.channel === 'email') displayBody = stripEmailThread(displayBody);

                // Outbound sender initials from sender_name
                const outboundInitials = getInitials(msg.sender_name || 'You');
                // Inbound initials from sender or entity name
                const inboundInitials = getInitials(msg.sender_name || entityName);

                return (
                  <div key={msg.id}>
                    {/* Date divider */}
                    {showDateSep && (
                      <div className="flex items-center gap-3 py-4 my-2">
                        <div className="flex-1 h-px bg-border/60" />
                        <span className="text-[11px] font-semibold text-muted-foreground tracking-wide">
                          {format(new Date(msgTime), 'MMMM d')}
                        </span>
                        <div className="flex-1 h-px bg-border/60" />
                      </div>
                    )}

                    {/* Chat bubble */}
                    <div className={cn(
                      'flex items-end gap-2',
                      isOutbound ? 'justify-end' : 'justify-start',
                      sameSenderAsPrev ? 'mt-0.5' : 'mt-3'
                    )}>
                      {/* Inbound avatar */}
                      {isInbound && (
                        <div className="w-7 shrink-0">
                          {!sameSenderAsPrev ? (
                            <div className="h-7 w-7 rounded-full bg-[#2A5C42] flex items-center justify-center">
                              <span className="text-[10px] font-bold text-white">{inboundInitials}</span>
                            </div>
                          ) : <div className="h-7" />}
                        </div>
                      )}

                      <div className={cn('max-w-[75%] flex flex-col', isOutbound ? 'items-end' : 'items-start')}>
                        {/* Bubble */}
                        <div className={cn(
                          'px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words',
                          isOutbound
                            ? 'bg-[#2A5C42] text-white rounded-2xl rounded-br-md'
                            : 'bg-secondary text-foreground rounded-2xl rounded-bl-md'
                        )}>
                          {msg.subject && thread.channel === 'email' && displayBody !== msg.subject && (
                            <p className={cn(
                              'text-xs font-semibold mb-1.5',
                              isOutbound ? 'text-white/80' : 'text-foreground/70'
                            )}>{msg.subject}</p>
                          )}
                          {displayBody
                            ? thread.channel === 'email'
                              ? <div dangerouslySetInnerHTML={{ __html: displayBody }} className="prose prose-sm max-w-none [&_*]:text-inherit [&_a]:underline" />
                              : displayBody
                            : <span className="italic opacity-50">(No content)</span>}
                        </div>

                        {/* Sender + timestamp below bubble */}
                        {!sameSenderAsPrev && (
                          <div className={cn(
                            'flex items-center gap-1.5 mt-1 px-1',
                            isOutbound ? 'flex-row-reverse' : 'flex-row'
                          )}>
                            <span className="text-[10px] text-muted-foreground">
                              {isOutbound ? (msg.sender_name || 'You') : (msg.sender_name || entityName || 'Sender')}
                            </span>
                            <span className="text-[10px] text-muted-foreground/50">·</span>
                            <span className="text-[10px] text-muted-foreground/70">
                              {format(new Date(msgTime), 'h:mm a')}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Outbound avatar */}
                      {isOutbound && (
                        <div className="w-7 shrink-0">
                          {!sameSenderAsPrev ? (
                            <div className="h-7 w-7 rounded-full bg-[#C9A84C] flex items-center justify-center">
                              <span className="text-[10px] font-bold text-white">{outboundInitials}</span>
                            </div>
                          ) : <div className="h-7" />}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
          </div>
        </ScrollArea>

        {/* Reply — hidden for call channel */}
        {thread.channel !== 'call' && <div className="border-t border-border p-4">
          <div className="max-w-2xl mx-auto">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <RichTextEditor
                  value={replyHtml}
                  onChange={(html) => {
                    setReplyHtml(html);
                    const tmp = document.createElement('div');
                    tmp.innerHTML = html;
                    setReplyText(tmp.textContent || '');
                  }}
                  placeholder={`Reply via ${CHANNEL_LABELS[thread.channel] || thread.channel}...`}
                  minHeight="60px"
                />
              </div>
              <div className="flex flex-col gap-1">
                <TemplatePickerPopover
                  channel={thread.channel}
                  onInsert={(template) => {
                    setReplyHtml(template.body);
                    const tmp = document.createElement('div');
                    tmp.innerHTML = template.body;
                    setReplyText(tmp.textContent || '');
                  }}
                />
                <Button
                  variant="gold"
                  onClick={handleSend}
                  disabled={sending || !replyText.trim()}
                  className="h-[40px] px-4"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>}
      </div>

      {/* Entity side panel */}
      {showEntity && (
        <div className="w-72 border-l border-border overflow-hidden">
          <EntityPanel thread={thread} messages={messages} />
        </div>
      )}

      {/* Create Person Dialog (from banner or sidebar) */}
      {isUnlinked && (
        <CreatePersonDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          threadId={thread.id}
          defaultType={createDialogType}
          prefill={{ name: senderName, address: senderAddress }}
          channel={thread.channel}
        />
      )}
    </div>
  );
}

// ---------- Admin emails — can see all messages ----------
const ADMIN_EMAILS = [
  'chris.sullivan@emeraldrecruit.com',
  'emeraldrecruit@theemeraldrecruitinggroup.com',
];

// ---------- Main Page ----------
export default function Inbox() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState('all');
  const [composeOpen, setComposeOpen] = useState(false);

  // Get current user for permission check
  const { data: currentUser } = useQuery({
    queryKey: ['current_user'],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user;
    },
  });

  const userEmail = currentUser?.email?.toLowerCase() || '';
  const userId = currentUser?.id || '';
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  // Get the current user's integration accounts (for non-admin filtering)
  const { data: myAccounts = [] } = useQuery({
    queryKey: ['my_integration_accounts', userId],
    enabled: !!userId && !isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('id')
        .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`);
      if (error) throw error;
      return (data || []).map((a: any) => a.id);
    },
  });

  const { data: allThreads = [], isLoading } = useQuery({
    queryKey: ['inbox_threads', isAdmin, userId, myAccounts],
    enabled: !!userId,
    queryFn: async () => {
      let query = supabase
        .from('inbox_threads').select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false });

      // Non-admin: only show threads owned by this user or using their integration accounts
      if (!isAdmin && userId) {
        const filters: string[] = [`owner_id.eq.${userId}`];
        if (myAccounts.length > 0) {
          filters.push(`integration_account_id.in.(${myAccounts.join(',')})`);
          filters.push(`account_id.in.(${myAccounts.join(',')})`);
        }
        query = query.or(filters.join(','));
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as InboxThread[];
    },
  });

  const filtered = allThreads.filter((t) => {
    // Channel filter
    if (filterTab === 'email' && t.channel !== 'email') return false;
    if (filterTab === 'sms' && t.channel !== 'sms') return false;
    if (filterTab === 'linkedin' && t.channel !== 'linkedin') return false;
    if (filterTab === 'candidates' && !t.candidate_id) return false;
    if (filterTab === 'contacts' && !t.contact_id) return false;
    if (filterTab === 'unlinked' && (t.candidate_id || t.contact_id)) return false;

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        t.subject?.toLowerCase().includes(q) ||
        t.last_message_preview?.toLowerCase().includes(q) ||
        t.candidate_name?.toLowerCase().includes(q) ||
        t.contact_name?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const unreadCount = allThreads.filter((t) => !t.is_read).length;

  return (
    <MainLayout>
      <PageHeader
        title="Inbox"
        description={unreadCount > 0 ? `${unreadCount} unread · All channels` : 'All channels · Unified'}
      />

      <ComposeMessageDialog open={composeOpen} onOpenChange={setComposeOpen} />

      <div className="flex" style={{ height: 'calc(100vh - 7rem)' }}>
        {/* Left: Thread List */}
        <div className="w-96 border-r border-border flex flex-col bg-background">
          {/* Search + Compose */}
          <div className="p-3 border-b border-border/60 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search messages, names..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <Button
              variant="gold"
              size="icon"
              onClick={() => setComposeOpen(true)}
              className="h-8 w-8 shrink-0"
              title="Compose new message"
            >
              <PenSquare className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Record type filters */}
          <div className="px-3 pt-2.5">
            <div className="flex gap-1 flex-wrap">
              {[
                { key: 'all', label: 'All', count: allThreads.length },
                { key: 'candidates', label: 'Candidates' },
                { key: 'contacts', label: 'Contacts' },
                { key: 'unlinked', label: 'Unlinked' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setFilterTab(tab.key)}
                  className={cn(
                    'text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors',
                    filterTab === tab.key
                      ? 'bg-accent text-accent-foreground border-accent'
                      : 'border-border text-muted-foreground hover:border-accent/50 hover:text-foreground'
                  )}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className="ml-1 opacity-70">{tab.count}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Channel filters */}
          <div className="px-3 pt-1.5 pb-2.5">
            <div className="flex gap-1">
              {[
                { key: 'email', label: 'Email', Icon: Mail },
                { key: 'sms', label: 'SMS', Icon: MessageSquare },
                { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin },
              ].map(({ key, label, Icon: Ico }) => (
                <button
                  key={key}
                  onClick={() => setFilterTab(filterTab === key ? 'all' : key)}
                  className={cn(
                    'flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors',
                    filterTab === key
                      ? 'bg-accent text-accent-foreground border-accent'
                      : 'border-border text-muted-foreground hover:border-accent/50 hover:text-foreground'
                  )}
                >
                  <Ico className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Thread list */}
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground px-6 text-center">
                <Mail className="h-10 w-10 mb-3 opacity-25" />
                <p className="text-sm font-medium mb-1">No conversations</p>
                <p className="text-xs opacity-70">
                  {searchQuery ? 'No results for your search' : 'Incoming messages will appear here'}
                </p>
              </div>
            ) : (
              <div>
                {filtered.map((thread) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    isSelected={selectedId === thread.id}
                    onClick={() => setSelectedId(thread.id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right: Message pane */}
        <div className="flex-1 min-w-0">
          <MessagePane threadId={selectedId} />
        </div>
      </div>
    </MainLayout>
  );
}
