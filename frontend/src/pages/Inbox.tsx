import { useState, useEffect, useRef } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { invalidateCommsScope } from '@/lib/invalidate';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Target, Send, Loader2, MoreVertical, Check,
  ChevronRight, Circle, CheckCircle2, AlertCircle, MapPin,
  Building, Link as LinkIcon, UserPlus, ArrowLeft, ArrowRight,
  PenSquare, Plus, Paperclip, X as XIcon, Trash2, UserRound,
  CheckSquare, Square, MailOpen, Archive,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Link } from 'react-router-dom';
import { ComposeMessageDialog } from '@/components/inbox/ComposeMessageDialog';
import { UnknownPersonBadge } from '@/components/inbox/UnknownPersonBadge';
import { AddPersonWizard } from '@/components/inbox/AddPersonWizard';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { TemplatePickerPopover } from '@/components/templates/TemplatePickerPopover';

// ---------- Types ----------
interface MessageAttachment {
  name: string;
  url?: string | null;
  storage_path?: string | null;
  mime_type?: string | null;
  size?: number | null;
}

interface InboxThread {
  id: string;
  channel: string;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  last_inbound_preview: string | null;
  sort_at: string | null;
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
  attachments: MessageAttachment[] | null;
}

// ---------- Constants ----------
// Classic LinkedIn messages only — Recruiter InMails get their own tab.
const LINKEDIN_CHANNELS = ['linkedin'] as const;

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  sms: MessageSquare,
  linkedin: Linkedin,
  linkedin_recruiter: Linkedin,
  phone: Phone,
  call: Phone,
};
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  linkedin_recruiter: 'Recruiter',
  phone: 'Phone',
  call: 'Call',
};
const CHANNEL_COLORS: Record<string, string> = {
  email: 'bg-info/10 text-info',
  linkedin: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  linkedin_recruiter: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  sms: 'bg-success/10 text-success',
  phone: 'bg-accent/10 text-accent',
  call: 'bg-[#C9A84C]/10 text-[#C9A84C]',
};

// ---------- Thread Item ----------
function ThreadItem({
  thread,
  isSelected,
  isChecked,
  selectionActive,
  onClick,
  onToggleCheck,
}: {
  thread: InboxThread;
  isSelected: boolean;
  isChecked: boolean;
  selectionActive: boolean;
  onClick: () => void;
  onToggleCheck: (shiftKey: boolean) => void;
}) {
  const Icon = CHANNEL_ICONS[thread.channel] || Mail;
  const entityName = thread.candidate_name || thread.contact_name;
  const isLinked = !!(thread.candidate_id || thread.contact_id);
  // Prefer the latest INBOUND message for the preview — sent messages should
  // not "push" the conversation in the inbox. Fall back to last_message_* for
  // conversations that do not yet have any received messages (e.g. outreach
  // you initiated that has not been replied to).
  const previewText = thread.last_inbound_preview ?? thread.last_message_preview;
  const previewTime = thread.last_inbound_at ?? thread.last_message_at;
  const awaitingReply = !thread.last_inbound_at && !!thread.last_message_at;

  return (
    <div
      className={cn(
        'group w-full text-left px-3 py-3.5 border-b border-border/60 hover:bg-muted/40 transition-colors relative cursor-pointer',
        isSelected && 'bg-accent/8 border-l-2 border-l-accent',
        isChecked && 'bg-accent/12',
        !thread.is_read && !isSelected && !isChecked && 'bg-muted/20'
      )}
      onClick={(e) => {
        // Cmd/Ctrl-click toggles selection; plain click opens
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onToggleCheck(e.shiftKey);
          return;
        }
        onClick();
      }}
    >
      <div className="flex items-start gap-2">
        {/* Checkbox column — always reserves space when selection is active so
            the rest of the row doesn't jump around mid-select. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(e.shiftKey);
          }}
          className={cn(
            'shrink-0 mt-1 transition-opacity',
            selectionActive || isChecked
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-70',
          )}
          title="Select"
        >
          {isChecked ? (
            <CheckSquare className="h-4 w-4 text-accent" />
          ) : (
            <Square className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
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
              {previewTime
                ? formatDistanceToNow(new Date(previewTime), { addSuffix: true })
                : ''}
            </span>
          </div>
          {thread.subject && (
            <p className={cn('text-xs truncate mb-0.5', !thread.is_read ? 'text-foreground/80 font-medium' : 'text-foreground/70')}>
              {thread.subject}
            </p>
          )}
          <p className="text-xs text-muted-foreground truncate">
            {awaitingReply ? (
              <span className="italic opacity-70">Awaiting reply…</span>
            ) : (
              previewText || '—'
            )}
          </p>
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
    </div>
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

  const { data: candidate } = useQuery({
    queryKey: ['candidate', thread?.candidate_id],
    enabled: !!thread?.candidate_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('people').select('*').eq('id', thread!.candidate_id!).single();
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
      supabase.from('people').select('id, full_name, email:primary_email, current_title, current_company').or(`full_name.ilike.%${q}%,primary_email.ilike.%${q}%`).limit(5),
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
      invalidateCommsScope(queryClient);
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

            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="w-full gap-1.5 text-xs"
            >
              <UserPlus className="h-3.5 w-3.5 text-accent" />
              Add Person
            </Button>
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

      {/* Add Person Wizard */}
      <AddPersonWizard
        open={createOpen}
        onOpenChange={setCreateOpen}
        threadId={thread.id}
        channel={thread.channel}
        prefill={{
          name: senderName,
          email: senderAddress.includes('@') ? senderAddress : '',
          phone: thread.channel === 'sms' ? senderAddress : '',
          linkedinUrl: thread.channel?.startsWith('linkedin') ? senderAddress : '',
        }}
        rawBody={firstInbound?.body || undefined}
        externalConversationId={thread.external_conversation_id}
        integrationAccountId={thread.integration_account_id}
        onPersonLinked={() => {
          invalidateCommsScope(queryClient);
        }}
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

// ---------- Attachments ----------
const MESSAGE_ATTACHMENTS_BUCKET = 'message-attachments';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveAttachmentUrl(att: MessageAttachment): Promise<string | null> {
  if (att.url) return att.url;
  if (!att.storage_path) return null;
  const { data } = await supabase.storage
    .from(MESSAGE_ATTACHMENTS_BUCKET)
    .createSignedUrl(att.storage_path, 60 * 60); // 1 hour
  return data?.signedUrl ?? null;
}

function MessageAttachmentList({
  attachments,
  isOutbound,
}: {
  attachments: MessageAttachment[] | null;
  isOutbound: boolean;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={cn('mt-2 flex flex-col gap-1.5', isOutbound ? 'items-end' : 'items-start')}>
      {attachments.map((att, i) => (
        <button
          key={`${att.storage_path || att.url || att.name}-${i}`}
          onClick={async (e) => {
            e.stopPropagation();
            const url = await resolveAttachmentUrl(att);
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
            else toast.error('Could not resolve attachment URL');
          }}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-w-full transition-colors',
            isOutbound
              ? 'bg-white/10 hover:bg-white/20 text-white'
              : 'bg-background/70 hover:bg-background text-foreground border border-border/60'
          )}
          title={att.name}
        >
          <Paperclip className="h-3.5 w-3.5 shrink-0 opacity-80" />
          <span className="text-xs truncate max-w-[220px]">{att.name}</span>
          {att.size ? (
            <span className={cn('text-[10px] shrink-0', isOutbound ? 'text-white/60' : 'text-muted-foreground')}>
              {formatBytes(att.size)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

interface PendingAttachment {
  id: string;
  file: File;
  storage_path?: string;
  uploading: boolean;
  error?: string;
}

async function uploadAttachment(
  conversationId: string,
  file: File
): Promise<{ storage_path: string; name: string; size: number; mime_type: string }> {
  const ext = file.name.split('.').pop() || 'bin';
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${conversationId}/${Date.now()}-${crypto.randomUUID()}-${safeBase}`;
  const { error } = await supabase.storage
    .from(MESSAGE_ATTACHMENTS_BUCKET)
    .upload(path, file, {
      contentType: file.type || `application/${ext}`,
      upsert: false,
    });
  if (error) throw error;
  return {
    storage_path: path,
    name: file.name,
    size: file.size,
    mime_type: file.type || 'application/octet-stream',
  };
}

// ---------- Message Detail ----------
function MessagePane({ threadId, onDeleted }: { threadId: string | null; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [replyHtml, setReplyHtml] = useState('');
  const [sending, setSending] = useState(false);
  const [showEntity, setShowEntity] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteThread = async () => {
    if (!threadId) return;
    setDeleting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token || '';
      const res = await fetch('/api/delete-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversation_id: threadId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to delete thread');
      }
      toast.success('Conversation deleted');
      invalidateCommsScope(queryClient);
      onDeleted?.();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete thread');
    } finally {
      setDeleting(false);
    }
  };
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
      // attachments is a JSONB column — cast through unknown to our typed shape.
      return (data ?? []) as unknown as Message[];
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
    invalidateCommsScope(queryClient);
  };

  const handlePickFiles = () => fileInputRef.current?.click();

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // reset so the same file can be picked again
    if (!threadId || files.length === 0) return;

    const accepted: PendingAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is too large (max 15 MB)`);
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        uploading: true,
      });
    }
    if (accepted.length === 0) return;
    setPendingAttachments((prev) => [...prev, ...accepted]);

    await Promise.all(
      accepted.map(async (pending) => {
        try {
          const uploaded = await uploadAttachment(threadId, pending.file);
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id ? { ...p, uploading: false, storage_path: uploaded.storage_path } : p
            )
          );
        } catch (err: any) {
          console.error('Attachment upload error:', err);
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id ? { ...p, uploading: false, error: err?.message || 'Upload failed' } : p
            )
          );
          toast.error(`Failed to upload ${pending.file.name}`);
        }
      })
    );
  };

  const removePendingAttachment = async (id: string) => {
    const target = pendingAttachments.find((p) => p.id === id);
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
    if (target?.storage_path) {
      await supabase.storage.from(MESSAGE_ATTACHMENTS_BUCKET).remove([target.storage_path]).catch(() => {});
    }
  };

  const handleSend = async () => {
    const html = replyHtml || editorRef.current?.innerHTML || '';
    const text = replyText || editorRef.current?.textContent || '';
    const hasAttachments = pendingAttachments.length > 0;
    if ((!text.trim() && !hasAttachments) || !threadId || !thread) return;
    if (pendingAttachments.some((p) => p.uploading)) {
      toast.error('Please wait for attachments to finish uploading');
      return;
    }
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
      } else if (LINKEDIN_CHANNELS.includes(thread.channel as any)) {
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
      if (!sendAccountId && LINKEDIN_CHANNELS.includes(thread.channel as any)) {
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

      const attachmentsPayload = pendingAttachments
        .filter((p) => !!p.storage_path && !p.error)
        .map((p) => ({
          name: p.file.name,
          storage_path: p.storage_path!,
          size: p.file.size,
          mime_type: p.file.type || 'application/octet-stream',
        }));

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
          attachments: attachmentsPayload.length > 0 ? attachmentsPayload : undefined,
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Send failed');

      toast.success(`Message sent via ${CHANNEL_LABELS[thread.channel] || thread.channel}`);
      setReplyText('');
      setReplyHtml('');
      setPendingAttachments([]);
      if (editorRef.current) editorRef.current.innerHTML = '';
      invalidateCommsScope(queryClient);
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
              {isUnlinked ? (
                <UnknownPersonBadge
                  senderName={senderName || undefined}
                  senderEmail={senderAddress.includes('@') ? senderAddress : undefined}
                  senderPhone={!senderAddress.includes('@') && senderAddress ? senderAddress : undefined}
                  channel={thread.channel}
                  onAdd={() => setCreateDialogOpen(true)}
                />
              ) : (
                (() => {
                  const target = thread.candidate_id
                    ? `/candidates/${thread.candidate_id}`
                    : thread.contact_id
                      ? `/contacts/${thread.contact_id}`
                      : null;
                  return target ? (
                    <Link to={target} className="text-sm font-semibold text-foreground truncate hover:text-emerald hover:underline transition-colors">
                      {entityName}
                    </Link>
                  ) : (
                    <h2 className="text-sm font-semibold text-foreground truncate">{entityName}</h2>
                  );
                })()
              )}
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
              className={showEntity ? 'text-accent' : ''}
            >
              <Users className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" disabled={deleting} title="Delete conversation">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the conversation and its message history. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDeleteThread}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Unlinked banner */}
        {isUnlinked && (
          <div className="px-6 py-2.5 bg-warning/5 border-b border-warning/20 flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />
            <p className="text-xs text-warning">
              <span className="font-medium">Not in your database.</span>{' '}
              <button onClick={() => setCreateDialogOpen(true)} className="underline hover:no-underline">
                Add this person
              </button>{' '}
              to track them.
            </p>
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
                          <MessageAttachmentList attachments={msg.attachments} isOutbound={isOutbound} />
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
            {/* Pending attachments */}
            {pendingAttachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pendingAttachments.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                      p.error
                        ? 'border-destructive/50 bg-destructive/5 text-destructive'
                        : 'border-border bg-muted/30 text-foreground'
                    )}
                  >
                    {p.uploading ? (
                      <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    ) : (
                      <Paperclip className="h-3 w-3 shrink-0 opacity-70" />
                    )}
                    <span className="truncate max-w-[180px]" title={p.file.name}>{p.file.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatBytes(p.file.size)}
                    </span>
                    <button
                      onClick={() => removePendingAttachment(p.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Remove"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFilesSelected}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handlePickFiles}
                  disabled={sending}
                  title="Attach files"
                  className="h-[36px] w-[36px]"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Button
                  variant="gold"
                  onClick={handleSend}
                  disabled={
                    sending ||
                    (!replyText.trim() && pendingAttachments.length === 0) ||
                    pendingAttachments.some((p) => p.uploading)
                  }
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

      {/* Add Person Wizard (from badge, banner, or sidebar) */}
      {isUnlinked && (
        <AddPersonWizard
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          threadId={thread.id}
          channel={thread.channel}
          prefill={{
            name: senderName,
            email: senderAddress.includes('@') ? senderAddress : '',
            phone: thread.channel === 'sms' ? senderAddress : '',
            linkedinUrl: thread.channel?.startsWith('linkedin') ? senderAddress : '',
          }}
          rawBody={firstInbound?.body || undefined}
          externalConversationId={thread.external_conversation_id}
          integrationAccountId={thread.integration_account_id}
          onPersonLinked={() => {
            invalidateCommsScope(queryClient);
          }}
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

// ---------- Bulk Action Bar ----------
function BulkActionBar({
  count,
  filteredCount,
  allFilteredChecked,
  busy,
  onSelectAll,
  onClear,
  onMarkRead,
  onMarkUnread,
  onArchive,
  onDelete,
}: {
  count: number;
  filteredCount: number;
  allFilteredChecked: boolean;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="px-3 py-2 border-b border-border/60 bg-accent/8 flex items-center gap-1.5">
      <button
        onClick={onClear}
        title="Clear selection"
        className="text-muted-foreground hover:text-foreground"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
      <span className="text-xs font-medium text-foreground">
        {count} selected
      </span>
      {!allFilteredChecked && filteredCount > count && (
        <button
          onClick={onSelectAll}
          className="text-[11px] text-accent hover:underline ml-1"
        >
          Select all {filteredCount}
        </button>
      )}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onMarkRead}
        disabled={busy}
        title="Mark read"
        className="h-7 px-2"
      >
        <MailOpen className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onMarkUnread}
        disabled={busy}
        title="Mark unread"
        className="h-7 px-2"
      >
        <Mail className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onArchive}
        disabled={busy}
        title="Archive"
        className="h-7 px-2"
      >
        <Archive className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        disabled={busy}
        title="Delete"
        className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

// ---------- Main Page ----------
export default function Inbox() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState('all');
  const [composeOpen, setComposeOpen] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  // Bulk-select state: thread IDs the user has checked. The toolbar
  // appears whenever this is non-empty. lastCheckedId enables shift-click
  // range selection on long inbox lists.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const queryClient = useQueryClient();

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

  // For admins: load team members with their integration account IDs for the owner filter
  const { data: teamMembers = [] } = useQuery({
    queryKey: ['team_members_inbox'],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('id, email_address, account_label, owner_user_id')
        .eq('is_active', true);
      if (error) throw error;

      // Fetch profile names so the filter shows "Chris Sullivan" not "Chris Sullivan Email"
      const ownerIds = [...new Set((data || []).map(a => a.owner_user_id).filter(Boolean))];
      const profileMap: Record<string, string> = {};
      if (ownerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ownerIds);
        for (const p of profiles || []) {
          if (p.full_name) profileMap[p.id] = p.full_name;
        }
      }

      // Group account IDs by owner (one person may have multiple accounts)
      const byOwner: Record<string, { label: string; accountIds: string[] }> = {};
      for (const acct of data || []) {
        const key = acct.owner_user_id || acct.email_address || 'unknown';
        if (!byOwner[key]) {
          byOwner[key] = {
            label: (acct.owner_user_id && profileMap[acct.owner_user_id]) || acct.account_label || acct.email_address || 'Unknown',
            accountIds: [],
          };
        }
        byOwner[key].accountIds.push(acct.id);
      }
      return Object.entries(byOwner).map(([key, { label, accountIds }]) => ({
        key,
        label,
        accountIds,
      }));
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: allThreads = [], isLoading } = useQuery({
    queryKey: ['inbox_threads', isAdmin, userId, myAccounts],
    enabled: !!userId,
    queryFn: async () => {
      let query = supabase
        .from('inbox_threads').select('*')
        // sort_at = COALESCE(last_inbound_at, last_message_at), so threads
        // bubble up when a new inbound arrives, not when we reply.
        .order('sort_at', { ascending: false, nullsFirst: false });

      // Non-admin: only show threads from this user's integration accounts
      if (!isAdmin && userId) {
        if (myAccounts.length > 0) {
          query = query.in('integration_account_id', myAccounts);
        } else {
          return [];
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as InboxThread[];
    },
  });

  const filtered = allThreads.filter((t) => {
    // Admin owner filter — restrict to selected team member's accounts
    if (isAdmin && ownerFilter !== 'all') {
      const member = teamMembers.find((m: any) => m.key === ownerFilter);
      if (member && !member.accountIds.includes(t.integration_account_id)) return false;
    }

    // Channel filters
    if (filterTab === 'email' && t.channel !== 'email') return false;
    if (filterTab === 'sms' && t.channel !== 'sms') return false;
    if (filterTab === 'linkedin' && !LINKEDIN_CHANNELS.includes(t.channel as any)) return false;
    if (filterTab === 'recruiter' && t.channel !== 'linkedin_recruiter') return false;
    if (filterTab === 'candidates' && !t.candidate_id) return false;
    if (filterTab === 'contacts' && !t.contact_id) return false;
    if (filterTab === 'unlinked' && (t.candidate_id || t.contact_id)) return false;

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        t.subject?.toLowerCase().includes(q) ||
        t.last_message_preview?.toLowerCase().includes(q) ||
        t.last_inbound_preview?.toLowerCase().includes(q) ||
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
            <div className="flex gap-1 flex-wrap">
              {[
                { key: 'email', label: 'Email', Icon: Mail },
                { key: 'sms', label: 'SMS', Icon: MessageSquare },
                { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin },
                { key: 'recruiter', label: 'Recruiter', Icon: Target },
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

              {/* Admin user filter */}
              {isAdmin && teamMembers.length > 0 && (
                <select
                  value={ownerFilter}
                  onChange={(e) => setOwnerFilter(e.target.value)}
                  className="text-[11px] font-medium px-2 py-1 rounded-full border border-border bg-background text-muted-foreground hover:border-accent/50 hover:text-foreground transition-colors cursor-pointer ml-auto"
                >
                  <option value="all">All team</option>
                  {teamMembers.map((m: any) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Bulk-action toolbar — only shown while at least one row is checked. */}
          {checkedIds.size > 0 && (
            <BulkActionBar
              count={checkedIds.size}
              filteredCount={filtered.length}
              allFilteredChecked={
                filtered.length > 0 &&
                filtered.every((t) => checkedIds.has(t.id))
              }
              busy={bulkBusy}
              onSelectAll={() => {
                setCheckedIds(new Set(filtered.map((t) => t.id)));
              }}
              onClear={() => {
                setCheckedIds(new Set());
                setLastCheckedId(null);
              }}
              onMarkRead={async () => {
                setBulkBusy(true);
                const ids = Array.from(checkedIds);
                const { error } = await supabase
                  .from('conversations')
                  .update({ is_read: true } as any)
                  .in('id', ids);
                setBulkBusy(false);
                if (error) {
                  toast.error(`Mark read failed: ${error.message}`);
                  return;
                }
                toast.success(`${ids.length} marked read`);
                setCheckedIds(new Set());
                invalidateCommsScope(queryClient);
              }}
              onMarkUnread={async () => {
                setBulkBusy(true);
                const ids = Array.from(checkedIds);
                const { error } = await supabase
                  .from('conversations')
                  .update({ is_read: false } as any)
                  .in('id', ids);
                setBulkBusy(false);
                if (error) {
                  toast.error(`Mark unread failed: ${error.message}`);
                  return;
                }
                toast.success(`${ids.length} marked unread`);
                setCheckedIds(new Set());
                invalidateCommsScope(queryClient);
              }}
              onArchive={async () => {
                setBulkBusy(true);
                const ids = Array.from(checkedIds);
                const { error } = await supabase
                  .from('conversations')
                  .update({ is_archived: true } as any)
                  .in('id', ids);
                setBulkBusy(false);
                if (error) {
                  toast.error(`Archive failed: ${error.message}`);
                  return;
                }
                toast.success(`${ids.length} archived`);
                setCheckedIds(new Set());
                invalidateCommsScope(queryClient);
              }}
              onDelete={() => setConfirmBulkDelete(true)}
            />
          )}

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
                    isChecked={checkedIds.has(thread.id)}
                    selectionActive={checkedIds.size > 0}
                    onClick={() => setSelectedId(thread.id)}
                    onToggleCheck={(shiftKey) => {
                      const next = new Set(checkedIds);
                      // Shift-click: select range from lastCheckedId to this id.
                      if (shiftKey && lastCheckedId) {
                        const startIdx = filtered.findIndex((t) => t.id === lastCheckedId);
                        const endIdx = filtered.findIndex((t) => t.id === thread.id);
                        if (startIdx >= 0 && endIdx >= 0) {
                          const [a, b] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                          for (let i = a; i <= b; i++) next.add(filtered[i].id);
                          setCheckedIds(next);
                          setLastCheckedId(thread.id);
                          return;
                        }
                      }
                      if (next.has(thread.id)) next.delete(thread.id);
                      else next.add(thread.id);
                      setCheckedIds(next);
                      setLastCheckedId(thread.id);
                    }}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right: Message pane */}
        <div className="flex-1 min-w-0">
          <MessagePane threadId={selectedId} onDeleted={() => setSelectedId(null)} />
        </div>
      </div>

      {/* Bulk-delete confirm */}
      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {checkedIds.size} conversation{checkedIds.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the conversation thread and every
              message inside it. There's no undo. Linked candidates and
              contacts are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkBusy}
              onClick={async (e) => {
                e.preventDefault();
                setBulkBusy(true);
                try {
                  const ids = Array.from(checkedIds);
                  const { data: { session } } = await supabase.auth.getSession();
                  const token = session?.access_token;
                  const res = await fetch('/api/delete-conversation', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ conversation_ids: ids }),
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    throw new Error(j.error || `HTTP ${res.status}`);
                  }
                  if (selectedId && checkedIds.has(selectedId)) setSelectedId(null);
                  setCheckedIds(new Set());
                  setConfirmBulkDelete(false);
                  toast.success(`${ids.length} deleted`);
                  invalidateCommsScope(queryClient);
                } catch (err: any) {
                  toast.error(`Delete failed: ${err.message}`);
                } finally {
                  setBulkBusy(false);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
