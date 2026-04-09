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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Target, Send, Loader2, MoreVertical, Check,
  ChevronRight, Circle, CheckCircle2, AlertCircle, MapPin,
  Building, Link as LinkIcon, UserPlus, ArrowLeft, ArrowRight,
  PenSquare, Plus, ChevronsUpDown,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ComposeMessageDialog } from '@/components/inbox/ComposeMessageDialog';

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
  external_conversation_id: string | null;
  integration_account_id: string | null;
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
};
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  phone: 'Phone',
};
const CHANNEL_COLORS: Record<string, string> = {
  email: 'bg-info/10 text-info',
  linkedin: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  sms: 'bg-success/10 text-success',
  phone: 'bg-accent/10 text-accent',
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
  externalConversationId,
  integrationAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  defaultType: 'candidate' | 'contact';
  prefill: { name: string; address: string };
  channel: string;
  externalConversationId?: string | null;
  integrationAccountId?: string | null;
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
  const [dbMatches, setDbMatches] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const dbSearchedRef = useRef(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [minDelayDone, setMinDelayDone] = useState(false);

  // Show processing phase for at least 800ms so user sees the steps
  useEffect(() => {
    if (!open) { setMinDelayDone(false); return; }
    const timer = setTimeout(() => setMinDelayDone(true), 800);
    return () => clearTimeout(timer);
  }, [open]);

  // Fetch companies for autocomplete
  const { data: companies = [] } = useQuery({
    queryKey: ['companies_autocomplete'],
    queryFn: async () => {
      const { data } = await supabase.from('companies').select('id, name').order('name');
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Helper: run Unipile profile resolution given a LinkedIn slug or provider ID
  const resolveUnipileProfile = async (slug: string) => {
    if (!slug || resolvedRef.current) return;
    resolvedRef.current = true;
    setResolving(true);

    try {
      const urlMatch = slug.match(/linkedin\.com\/in\/([^/?#]+)/);
      const identifier = urlMatch ? urlMatch[1] : slug;

      const { data: accounts } = await supabase
        .from('integration_accounts')
        .select('unipile_account_id')
        .not('unipile_account_id', 'is', null)
        .eq('is_active', true)
        .limit(3);

      const accountId = accounts?.[0]?.unipile_account_id;
      if (!accountId) {
        console.warn('No active Unipile account found — skipping profile resolution');
        return;
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const resp = await fetch(`${supabaseUrl}/functions/v1/resolve-unipile-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: supabaseKey },
        body: JSON.stringify({ linkedin_slug: identifier, account_id: accountId }),
      });

      if (resp.ok) {
        const profile = await resp.json();

        const { data: unipileCfg } = await supabase
          .from('user_integrations')
          .select('config')
          .eq('integration_type', 'unipile')
          .limit(1)
          .maybeSingle();

        const cfg = unipileCfg?.config as any;
        let fullProfile: any = null;

        if (cfg?.api_key && cfg?.base_url && (profile.unipile_id || identifier)) {
          try {
            const profileResp = await fetch(
              `${cfg.base_url.replace(/\/+$/, '')}/api/v1/users/${profile.unipile_id || identifier}` +
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

        setForm(prev => ({
          ...prev,
          first_name: fullProfile?.first_name || profile.name?.split(' ')[0] || prev.first_name,
          last_name: fullProfile?.last_name || profile.name?.split(' ').slice(1).join(' ') || prev.last_name,
          title: fullProfile?.headline || fullProfile?.title || fullProfile?.current_title || prev.title,
          company: fullProfile?.company || fullProfile?.current_company || fullProfile?.company_name || prev.company,
          location: fullProfile?.location || fullProfile?.region || prev.location,
          linkedin_url: fullProfile?.public_profile_url || fullProfile?.linkedin_url || (identifier.startsWith('http') ? identifier : `https://linkedin.com/in/${identifier}`),
          email: fullProfile?.email || prev.email,
          phone: fullProfile?.phone || fullProfile?.phone_number || prev.phone,
        }));
      }
    } catch (err) {
      console.warn('Unipile profile resolution failed:', err);
    } finally {
      setResolving(false);
    }
  };

  // For LinkedIn channels: resolve profile when dialog opens
  useEffect(() => {
    if (!open || channel !== 'linkedin') return;

    if (prefill.address) {
      resolveUnipileProfile(prefill.address);
      return;
    }

    if (!externalConversationId) return;

    (async () => {
      setResolving(true);
      try {
        const { data: unipileCfg } = await supabase
          .from('user_integrations')
          .select('config')
          .eq('integration_type', 'unipile')
          .limit(1)
          .maybeSingle();
        const cfg = unipileCfg?.config as any;
        if (!cfg?.api_key || !cfg?.base_url) return;

        let accountId: string | null = null;
        if (integrationAccountId) {
          const { data: ia } = await supabase
            .from('integration_accounts')
            .select('unipile_account_id')
            .eq('id', integrationAccountId)
            .maybeSingle();
          accountId = ia?.unipile_account_id || null;
        }
        if (!accountId) {
          const { data: accounts } = await supabase
            .from('integration_accounts')
            .select('unipile_account_id')
            .not('unipile_account_id', 'is', null)
            .eq('is_active', true)
            .limit(1);
          accountId = accounts?.[0]?.unipile_account_id || null;
        }
        if (!accountId) return;

        const chatResp = await fetch(
          `${cfg.base_url.replace(/\/+$/, '')}/chats/${externalConversationId}`,
          { headers: { 'X-API-KEY': cfg.api_key, Accept: 'application/json' } },
        );
        if (!chatResp.ok) return;
        const chatData = await chatResp.json();

        const attendees = chatData.attendees || chatData.participants || [];
        const other = attendees.find((a: any) =>
          a.provider_id !== accountId && a.id !== accountId
        ) || attendees[0];

        if (other) {
          const name = other.display_name || other.name || '';
          const parts = name.split(' ');
          setForm(prev => ({
            ...prev,
            first_name: parts[0] || prev.first_name,
            last_name: parts.slice(1).join(' ') || prev.last_name,
            linkedin_url: other.public_profile_url || other.linkedin_url || (other.provider_id ? `https://linkedin.com/in/${other.provider_id}` : prev.linkedin_url),
            title: other.headline || other.title || prev.title,
            company: other.company || prev.company,
            location: other.location || prev.location,
          }));

          const profileId = other.provider_id || other.id;
          if (profileId) {
            resolveUnipileProfile(profileId);
          }
        }
      } catch (err) {
        console.warn('Chat attendee lookup failed:', err);
      } finally {
        if (!resolvedRef.current) setResolving(false);
      }
    })();
  }, [open]);

  // Auto-search database for existing matches when dialog opens
  useEffect(() => {
    if (!open || dbSearchedRef.current) return;
    const name = prefill.name?.trim();
    const address = prefill.address?.trim();

    dbSearchedRef.current = true;
    setSearching(true);

    (async () => {
      try {
        const filters: string[] = [];
        if (name) filters.push(`full_name.ilike.%${name}%`);
        if (address && address.includes('@')) filters.push(`email.ilike.%${address}%`);
        const orFilter = filters.join(',');
        if (!orFilter) {
          setSearching(false);
          return;
        }

        const [cRes, ctRes] = await Promise.all([
          supabase.from('candidates').select('id, full_name, email, current_title, current_company, phone, linkedin_url, location').or(orFilter).limit(3),
          supabase.from('contacts').select('id, full_name, email, title, phone, linkedin_url').or(orFilter).limit(3),
        ]);

        const results = [
          ...(cRes.data || []).map(r => ({ ...r, entity_type: 'candidate' as const })),
          ...(ctRes.data || []).map(r => ({ ...r, entity_type: 'contact' as const })),
        ];
        setDbMatches(results);

        if (results.length > 0) {
          const best = results[0];
          setForm(prev => ({
            ...prev,
            first_name: best.full_name?.split(' ')[0] || prev.first_name,
            last_name: best.full_name?.split(' ').slice(1).join(' ') || prev.last_name,
            email: best.email || prev.email,
            phone: best.phone || prev.phone,
            linkedin_url: best.linkedin_url || prev.linkedin_url,
            title: (best as any).current_title || (best as any).title || prev.title,
            company: (best as any).current_company || prev.company,
            location: (best as any).location || prev.location,
          }));

          if (channel !== 'linkedin' && best.linkedin_url) {
            resolveUnipileProfile(best.linkedin_url);
          }
        }
      } catch (err) {
        console.warn('DB match search failed:', err);
      } finally {
        setSearching(false);
      }
    })();
  }, [open, prefill.name, prefill.address]);

  // Reset form when dialog opens with new prefill
  const resetForm = () => {
    const parts = prefill.name.split(' ');
    const emailAddr = prefill.address.includes('@');
    resolvedRef.current = false;
    dbSearchedRef.current = false;
    setDbMatches([]);
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
    setCompanyId(null);
    setMinDelayDone(false);
  };

  // Link conversation to an existing record instead of creating new
  const handleLinkExisting = async (entityType: string, entityId: string, entityName: string) => {
    setLinking(true);
    try {
      const update: any = {};
      if (entityType === 'candidate') update.candidate_id = entityId;
      if (entityType === 'contact') update.contact_id = entityId;

      const { error } = await supabase.from('conversations').update(update).eq('id', threadId);
      if (error) throw error;

      const msgUpdate: any = {};
      if (entityType === 'candidate') msgUpdate.candidate_id = entityId;
      if (entityType === 'contact') msgUpdate.contact_id = entityId;
      await supabase.from('messages').update(msgUpdate).eq('conversation_id', threadId).is(entityType === 'candidate' ? 'candidate_id' : 'contact_id', null);

      toast.success(`Linked to ${entityName}`);
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
    } catch (err: any) {
      toast.error('Failed to link: ' + (err.message || 'Unknown error'));
    } finally {
      setLinking(false);
    }
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

        const { error: linkErr } = await supabase.from('conversations').update({ candidate_id: newRecord.id } as any).eq('id', threadId);
        if (linkErr) throw linkErr;

        await supabase.from('messages').update({ candidate_id: newRecord.id } as any).eq('conversation_id', threadId).is('candidate_id', null);

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
          company_id: companyId || null,
          company_name: form.company.trim() || null,
          location: form.location.trim() || null,
          status: 'active',
          owner_id: userId,
        } as any).select('id, full_name').single();
        if (error) throw error;

        const { error: linkErr } = await supabase.from('conversations').update({ contact_id: newRecord.id } as any).eq('id', threadId);
        if (linkErr) throw linkErr;

        await supabase.from('messages').update({ contact_id: newRecord.id } as any).eq('conversation_id', threadId).is('contact_id', null);

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

  const isProcessing = searching || resolving || !minDelayDone;
  const isReady = !isProcessing;

  const processingSteps = [
    { label: 'Searching database for existing records', done: !searching, active: searching },
    ...(channel === 'linkedin' ? [{ label: 'Pulling LinkedIn profile via Unipile', done: !resolving && resolvedRef.current, active: resolving }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add New {type === 'candidate' ? 'Candidate' : 'Contact'}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? 'Looking up this person — hang tight...'
              : 'Review the details below and edit anything before saving.'}
          </DialogDescription>
        </DialogHeader>

        {/* Phase 1: Processing */}
        {isProcessing && (
          <div className="py-8 space-y-4">
            <div className="flex justify-center">
              <div className="relative">
                <Loader2 className="h-10 w-10 animate-spin text-accent" />
              </div>
            </div>
            <div className="space-y-2.5">
              {processingSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2.5 px-2">
                  {step.active ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-accent shrink-0" />
                  ) : step.done ? (
                    <Check className="h-3.5 w-3.5 text-success shrink-0" />
                  ) : (
                    <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
                  )}
                  <span className={cn('text-sm', step.active ? 'text-foreground' : step.done ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Phase 2: Review & Edit */}
        {isReady && (
          <>
            {/* Existing match banner */}
            {dbMatches.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-warning shrink-0" />
                  <p className="text-xs font-medium text-warning">
                    {dbMatches.length === 1 ? 'Possible match found — link instead?' : `${dbMatches.length} possible matches — link instead?`}
                  </p>
                </div>
                {dbMatches.slice(0, 3).map((match) => (
                  <div key={match.id + match.entity_type} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                    {match.entity_type === 'candidate'
                      ? <UserCheck className="h-3.5 w-3.5 text-success shrink-0" />
                      : <Users className="h-3.5 w-3.5 text-info shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{match.full_name}</p>
                      <p className="text-[10px] text-muted-foreground truncate capitalize">
                        {match.entity_type} · {match.current_title || match.title || match.email || ''}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[10px] gap-1 shrink-0"
                      disabled={linking}
                      onClick={() => handleLinkExisting(match.entity_type, match.id, match.full_name)}
                    >
                      {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : <LinkIcon className="h-3 w-3" />}
                      Link
                    </Button>
                  </div>
                ))}
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{type === 'candidate' ? 'Current Company' : 'Company'}</Label>
                  <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={companyOpen}
                        className="h-9 w-full justify-between font-normal text-sm"
                      >
                        <span className={cn('truncate', !form.company && 'text-muted-foreground')}>
                          {form.company || 'Search companies...'}
                        </span>
                        <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[240px] p-0" align="start">
                      <Command>
                        <CommandInput
                          placeholder="Type to search..."
                          value={form.company}
                          onValueChange={(v) => {
                            setForm(f => ({ ...f, company: v }));
                            setCompanyId(null);
                          }}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {form.company.trim() ? (
                              <button
                                className="w-full px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  setCompanyId(null);
                                  setCompanyOpen(false);
                                }}
                              >
                                Use "{form.company}" as new company
                              </button>
                            ) : (
                              <span className="text-xs text-muted-foreground">No companies found</span>
                            )}
                          </CommandEmpty>
                          <CommandGroup>
                            {companies
                              .filter((c: any) => c.name?.toLowerCase().includes((form.company || '').toLowerCase()))
                              .slice(0, 8)
                              .map((c: any) => (
                                <CommandItem
                                  key={c.id}
                                  value={c.name}
                                  onSelect={() => {
                                    setForm(f => ({ ...f, company: c.name }));
                                    setCompanyId(c.id);
                                    setCompanyOpen(false);
                                  }}
                                >
                                  <Building className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                                  {c.name}
                                  {companyId === c.id && <Check className="ml-auto h-3.5 w-3.5 text-success" />}
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
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

              <div className="space-y-1.5">
                <Label className="text-xs">LinkedIn URL</Label>
                <Input
                  value={form.linkedin_url}
                  onChange={(e) => setForm(f => ({ ...f, linkedin_url: e.target.value }))}
                  placeholder="https://linkedin.com/in/..."
                  className="h-9"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                variant="gold"
                onClick={handleCreate}
                disabled={creating || (!form.first_name.trim() && !form.last_name.trim())}
                className="gap-1.5"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create & Link
              </Button>
            </DialogFooter>
          </>
        )}
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
      // Backfill messages in this conversation
      await supabase.from('messages').update(update).eq('conversation_id', thread.id).is(entityType === 'candidate' ? 'candidate_id' : 'contact_id', null);
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
            {/* Entity header */}
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
                {entity.full_name?.slice(0, 2).toUpperCase() || '??'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-foreground truncate">{entity.full_name}</p>
                  <Badge variant="outline" className="text-[9px] capitalize">
                    {entityType}
                  </Badge>
                </div>
                {(entity as any).current_title && (
                  <p className="text-xs text-muted-foreground truncate">{(entity as any).current_title}</p>
                )}
                {(entity as any).title && (
                  <p className="text-xs text-muted-foreground truncate">{(entity as any).title}</p>
                )}
              </div>
            </div>

            {/* Contact info */}
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
                  <a href={entity.linkedin_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    LinkedIn
                  </a>
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

            {/* Link to full record */}
            {entityType === 'candidate' && (
              <Link to={`/candidates/${thread.candidate_id}`}>
                <Button variant="outline" size="sm" className="w-full gap-1.5">
                  <UserCheck className="h-3.5 w-3.5" />
                  View Candidate
                  <ArrowRight className="h-3 w-3 ml-auto" />
                </Button>
              </Link>
            )}
            {entityType === 'contact' && (
              <Link to={`/contacts/${thread.contact_id}`}>
                <Button variant="outline" size="sm" className="w-full gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  View Contact
                  <ArrowRight className="h-3 w-3 ml-auto" />
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
                <p className="text-[10px] text-muted-foreground mt-1">
                  {format(new Date(n.created_at), 'MMM d, yyyy')}
                </p>
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
        externalConversationId={thread.external_conversation_id}
        integrationAccountId={thread.integration_account_id}
      />
    </div>
  );
}

// ---------- Message Detail ----------
function MessagePane({ threadId }: { threadId: string | null }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEntity, setShowEntity] = useState(true);

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

  const handleMarkRead = async () => {
    if (!threadId || thread?.is_read) return;
    await supabase.from('conversations').update({ is_read: true }).eq('id', threadId);
    queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
    queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
  };

  const handleSend = async () => {
    if (!replyText.trim() || !threadId || !thread) return;
    setSending(true);
    try {
      // Determine recipient address based on channel
      let toAddress = '';
      const lastInbound = messages.find((m) => m.direction === 'inbound');
      
      if (thread.channel === 'email') {
        toAddress = lastInbound?.sender_address || '';
      } else if (thread.channel === 'sms') {
        toAddress = lastInbound?.sender_address || '';
      } else if (thread.channel === 'linkedin') {
        // For LinkedIn, use the provider_id from candidate_channels
        const { data: channelData } = await supabase
          .from('candidate_channels')
          .select('provider_id, unipile_id')
          .eq('candidate_id', thread.candidate_id)
          .eq('channel', 'linkedin')
          .maybeSingle();
        toAddress = channelData?.provider_id || channelData?.unipile_id || '';
      }

      if (!toAddress) {
        toast.error(`No recipient address found for ${thread.channel}`);
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
          body: replyText.trim(),
          account_id: thread.account_id,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Send failed');

      toast.success(`Message sent via ${CHANNEL_LABELS[thread.channel] || thread.channel}`);
      setReplyText('');
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
            >
              <Users className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Messages scroll */}
        <ScrollArea className="flex-1 p-6">
          {msgsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <MessageSquare className="h-10 w-10 mb-3 opacity-20" />
              <p className="text-sm">No messages in this thread yet</p>
            </div>
          ) : (
            <div className="space-y-5 max-w-2xl">
              {messages.map((msg) => {
                const isInbound = msg.direction === 'inbound';
                return (
                  <div key={msg.id} className={cn('flex gap-3', isInbound ? 'justify-start' : 'justify-end')}>
                    {isInbound && (
                      <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          {(msg.sender_name || entityName || '?').slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div className={cn(
                      'max-w-[78%] rounded-2xl px-4 py-3',
                      isInbound
                        ? 'bg-muted rounded-tl-sm'
                        : 'bg-accent/10 border border-accent/20 rounded-tr-sm'
                    )}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs font-medium text-foreground/80">
                          {isInbound ? (msg.sender_name || entityName || 'Sender') : 'You'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {msg.sent_at
                            ? format(new Date(msg.sent_at), 'MMM d, h:mm a')
                            : msg.received_at
                            ? format(new Date(msg.received_at), 'MMM d, h:mm a')
                            : format(new Date(msg.created_at), 'MMM d, h:mm a')}
                        </span>
                      </div>
                      {msg.subject && thread.channel === 'email' && (
                        <p className="text-xs font-semibold text-foreground mb-1.5">{msg.subject}</p>
                      )}
                      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                        {msg.body || '(No content)'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Reply */}
        <div className="border-t border-border p-4">
          <div className="flex gap-2 items-end">
            <textarea
              placeholder={`Reply via ${CHANNEL_LABELS[thread.channel] || thread.channel}...`}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
              rows={2}
              className="flex-1 rounded-lg border border-input bg-background text-foreground text-sm px-3 py-2 resize-none placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button
              variant="gold"
              onClick={handleSend}
              disabled={sending || !replyText.trim()}
              className="h-[60px] px-4"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Entity side panel */}
      {showEntity && (
        <div className="w-72 border-l border-border overflow-hidden">
          <EntityPanel thread={thread} messages={messages} />
        </div>
      )}
    </div>
  );
}

// ---------- Main Page ----------
export default function Inbox() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState('all');
  const [composeOpen, setComposeOpen] = useState(false);

  const { data: allThreads = [], isLoading } = useQuery({
    queryKey: ['inbox_threads'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('inbox_threads').select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false });
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
