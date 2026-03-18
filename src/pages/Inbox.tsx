import { useState, useEffect, useMemo } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Loader2, Circle, CheckCircle2, AlertCircle,
  Building, Link as LinkIcon, ArrowRight, PenSquare, Send,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ComposeMessageDialog } from '@/components/inbox/ComposeMessageDialog';
import { InboxReplyBox } from '@/components/inbox/InboxReplyBox';

// ─── Constants ────────────────────────────────────────────────────────────────

const MARKETING_ACCOUNT_ID = '1b43351d-dcb4-4977-8872-7027ae1ccc83';
const MARKETING_USER_ID    = 'fc07e240-0e31-45d4-a8f1-ddec1042dd5f';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single row returned from the messages table (with joined names). */
interface MsgRow {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | string;
  channel: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address: string | null;
  candidate_id: string | null;
  contact_id: string | null;
  integration_account_id: string | null;
  candidate_name: string | null;
  contact_name: string | null;
  [key: string]: unknown; // unipile_chat_id, etc.
}

/** Thread metadata fetched via inbox_threads view for the detail pane. */
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

/** Full message row as used inside the thread detail pane. */
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
  candidate_id: string | null;
  contact_id: string | null;
  [key: string]: unknown;
}

// ─── Channel display helpers ──────────────────────────────────────────────────

const CH_ICON: Record<string, React.ElementType> = {
  email: Mail, sms: MessageSquare, linkedin: Linkedin, phone: Phone,
};
const CH_LABEL: Record<string, string> = {
  email: 'Email', sms: 'SMS', linkedin: 'LinkedIn', phone: 'Phone',
};
// pill colour used in list items
const CH_PILL: Record<string, string> = {
  email:    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400',
  linkedin: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400',
  sms:      'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400',
  phone:    'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400',
};
// avatar/icon background colour used in detail pane header
const CH_BG: Record<string, string> = {
  email:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  linkedin: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  sms:      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  phone:    'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
};

function channelIcon(ch: string) {
  return CH_ICON[ch] ?? Mail;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a list of message rows, keeps only the most-recent row per
 * conversation_id, then sorts newest-first.
 */
function dedupeByConversation(rows: MsgRow[]): MsgRow[] {
  const map = new Map<string, MsgRow>();
  for (const row of rows) {
    const existing = map.get(row.conversation_id);
    const t = (r: MsgRow) => new Date(r.sent_at ?? r.received_at ?? r.created_at).getTime();
    if (!existing || t(row) > t(existing)) map.set(row.conversation_id, row);
  }
  return [...map.values()].sort(
    (a, b) =>
      new Date(b.sent_at ?? b.received_at ?? b.created_at).getTime() -
      new Date(a.sent_at ?? a.received_at ?? a.created_at).getTime()
  );
}

const MSG_SELECT = [
  'id', 'conversation_id', 'direction', 'channel', 'subject', 'body',
  'sent_at', 'received_at', 'created_at',
  'sender_name', 'sender_address', 'recipient_address',
  'candidate_id', 'contact_id', 'integration_account_id',
  'candidates(full_name)', 'contacts(full_name)',
].join(', ');

function flattenRow(raw: any): MsgRow {
  return {
    ...raw,
    candidate_name: raw.candidates?.full_name ?? null,
    contact_name:   raw.contacts?.full_name   ?? null,
  };
}

// ─── Message list item ────────────────────────────────────────────────────────

function MsgListItem({
  row, isSelected, isSent, onClick,
}: {
  row: MsgRow; isSelected: boolean; isSent?: boolean; onClick: () => void;
}) {
  const Icon = channelIcon(row.channel);
  const name = row.candidate_name ?? row.contact_name
    ?? (isSent ? row.recipient_address : row.sender_address)
    ?? row.sender_name
    ?? 'Unknown';
  const preview = row.subject || row.body?.replace(/\n/g, ' ')?.slice(0, 100) || '—';
  const ts = row.sent_at ?? row.received_at ?? row.created_at;
  const pillClass = CH_PILL[row.channel] ?? 'bg-muted text-muted-foreground border-border';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3.5 border-b border-border/60 hover:bg-muted/40 transition-colors',
        isSelected && 'bg-accent/8 border-l-2 border-l-accent',
      )}
    >
      <div className="flex items-start gap-3">
        {/* Channel avatar */}
        <div className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          CH_BG[row.channel] ?? 'bg-muted text-muted-foreground'
        )}>
          <Icon className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + timestamp */}
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <span className="text-sm font-medium text-foreground truncate">{name}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {ts ? formatDistanceToNow(new Date(ts), { addSuffix: true }) : ''}
            </span>
          </div>

          {/* Preview */}
          <p className="text-xs text-muted-foreground truncate">{preview}</p>

          {/* Pills */}
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={cn('inline-flex items-center rounded border px-1.5 h-4 text-[9px] uppercase tracking-wide font-medium', pillClass)}>
              {CH_LABEL[row.channel] ?? row.channel}
            </span>
            {row.direction === 'inbound' && !isSent && (
              <Circle className="h-1.5 w-1.5 fill-emerald-500 text-emerald-500 shrink-0" />
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Entity side panel ────────────────────────────────────────────────────────

function EntityPanel({ thread }: { thread: InboxThread | null }) {
  const queryClient = useQueryClient();
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState<any[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [linking, setLinking] = useState(false);

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
      const { data, error } = await supabase.from('notes').select('*')
        .eq('entity_id', thread!.candidate_id!).eq('entity_type', 'candidate')
        .order('created_at', { ascending: false }).limit(5);
      if (error) throw error;
      return data;
    },
  });

  const handleSearch = async () => {
    if (!linkSearch.trim()) return;
    setLinkSearching(true);
    const q = linkSearch.trim();
    const [cRes, ctRes] = await Promise.all([
      supabase.from('candidates').select('id, full_name, email, current_title, current_company').ilike('full_name', `%${q}%`).limit(5),
      supabase.from('contacts').select('id, full_name, email, title').ilike('full_name', `%${q}%`).limit(5),
    ]);
    setLinkResults([
      ...(cRes.data || []).map(r => ({ ...r, entity_type: 'candidate' })),
      ...(ctRes.data || []).map(r => ({ ...r, entity_type: 'contact' })),
    ]);
    setLinkSearching(false);
  };

  const handleLink = async (entityType: string, entityId: string, entityName: string) => {
    if (!thread) return;
    setLinking(true);
    const update: any = entityType === 'candidate' ? { candidate_id: entityId } : { contact_id: entityId };
    const { error } = await supabase.from('conversations').update(update).eq('id', thread.id);
    if (error) {
      toast.error('Failed to link: ' + error.message);
    } else {
      toast.success(`Linked to ${entityName}`);
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      queryClient.invalidateQueries({ queryKey: ['inbox_thread', thread.id] });
      setLinkSearch(''); setLinkResults([]);
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
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">Linked Record</h3>

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
              {entity.email && <div className="flex items-center gap-2 text-xs text-foreground/80"><Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span className="truncate">{entity.email}</span></div>}
              {entity.phone && <div className="flex items-center gap-2 text-xs text-foreground/80"><Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{entity.phone}</span></div>}
              {entity.linkedin_url && <div className="flex items-center gap-2 text-xs text-foreground/80"><Linkedin className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={entity.linkedin_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a></div>}
              {(entity as any).current_company && <div className="flex items-center gap-2 text-xs text-foreground/80"><Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span className="truncate">{(entity as any).current_company}</span></div>}
              {(entity as any).companies?.name && <div className="flex items-center gap-2 text-xs text-foreground/80"><Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span className="truncate">{(entity as any).companies.name}</span></div>}
            </div>
            {entityType === 'candidate' && <Link to={`/candidates/${thread.candidate_id}`}><Button variant="outline" size="sm" className="w-full gap-1.5"><UserCheck className="h-3.5 w-3.5" />View Candidate<ArrowRight className="h-3 w-3 ml-auto" /></Button></Link>}
            {entityType === 'contact' && <Link to={`/contacts/${thread.contact_id}`}><Button variant="outline" size="sm" className="w-full gap-1.5"><Users className="h-3.5 w-3.5" />View Contact<ArrowRight className="h-3 w-3 ml-auto" /></Button></Link>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <p className="text-xs text-warning leading-relaxed">Not linked to any record. Search to link manually.</p>
            </div>
            <div className="flex gap-2">
              <Input placeholder="Search name…" value={linkSearch} onChange={(e) => setLinkSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSearch()} className="h-8 text-xs" />
              <Button size="sm" variant="outline" onClick={handleSearch} disabled={linkSearching} className="h-8 px-2">
                {linkSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {linkResults.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                {linkResults.map((r) => (
                  <button key={r.id + r.entity_type} onClick={() => handleLink(r.entity_type, r.id, r.full_name)} disabled={linking}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0 text-left">
                    {r.entity_type === 'candidate' ? <UserCheck className="h-3.5 w-3.5 text-success shrink-0" /> : <Users className="h-3.5 w-3.5 text-info shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{r.full_name}</p>
                      <p className="text-[10px] text-muted-foreground truncate capitalize">{r.entity_type} · {r.current_title || r.title || ''}</p>
                    </div>
                    <LinkIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
    </div>
  );
}

// ─── Thread detail pane ───────────────────────────────────────────────────────

function MessagePane({ threadId }: { threadId: string | null }) {
  const queryClient = useQueryClient();
  const [showEntity, setShowEntity] = useState(true);

  const { data: thread, isLoading: threadLoading } = useQuery({
    queryKey: ['inbox_thread', threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase.from('inbox_threads').select('*').eq('id', threadId!).single();
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

  // Enrollment threading fields for email replies
  const { data: enrollment } = useQuery({
    queryKey: ['enrollment_threading', thread?.candidate_id],
    enabled: !!thread?.candidate_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('sequence_enrollments')
        .select('email_last_message_id, email_thread_subject')
        .eq('candidate_id', thread!.candidate_id!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  const handleMarkRead = async () => {
    if (!threadId || thread?.is_read) return;
    await supabase.from('conversations').update({ is_read: true }).eq('id', threadId);
    queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
    queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
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

  if (threadLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!thread) return <div className="flex items-center justify-center h-full text-muted-foreground"><p className="text-sm">Conversation not found</p></div>;

  const Icon = channelIcon(thread.channel);
  const entityName = thread.candidate_name || thread.contact_name;

  // Channel comes from the last message — not the thread — for accurate reply routing
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const replyChannel = lastMsg?.channel || thread.channel;

  return (
    <div className="flex h-full">
      {/* Messages column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', CH_BG[thread.channel] ?? 'bg-muted text-muted-foreground')}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground truncate">{entityName || 'Unknown'}</h2>
              <Badge variant="secondary" className="text-[10px] uppercase shrink-0">
                {CH_LABEL[thread.channel] ?? thread.channel}
              </Badge>
            </div>
            {thread.subject && <p className="text-xs text-muted-foreground truncate">{thread.subject}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!thread.is_read && (
              <Button variant="ghost" size="sm" onClick={handleMarkRead} className="text-xs">
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Read
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => setShowEntity(v => !v)} title="Toggle contact panel">
              <Users className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Messages scroll */}
        <ScrollArea className="flex-1 p-6">
          {msgsLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
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
                    <div className={cn('max-w-[78%] rounded-2xl px-4 py-3',
                      isInbound ? 'bg-muted rounded-tl-sm' : 'bg-accent/10 border border-accent/20 rounded-tr-sm'
                    )}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs font-medium text-foreground/80">
                          {isInbound ? (msg.sender_name || entityName || 'Sender') : 'You'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {msg.sent_at ? format(new Date(msg.sent_at), 'MMM d, h:mm a')
                            : msg.received_at ? format(new Date(msg.received_at), 'MMM d, h:mm a')
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

        {/* Reply box — channel from last message, enrollment threading for email */}
        <InboxReplyBox
          threadId={threadId}
          channel={replyChannel}
          integrationAccountId={thread.account_id ?? null}
          candidateId={thread.candidate_id ?? null}
          messages={messages}
          emailLastMessageId={(enrollment as any)?.email_last_message_id ?? null}
          emailThreadSubject={(enrollment as any)?.email_thread_subject ?? null}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ['messages', threadId] });
            queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
            queryClient.invalidateQueries({ queryKey: ['inbox_msgs'] });
            queryClient.invalidateQueries({ queryKey: ['sent_msgs'] });
            queryClient.invalidateQueries({ queryKey: ['marketing_msgs'] });
          }}
        />
      </div>

      {showEntity && (
        <div className="w-72 border-l border-border overflow-hidden">
          <EntityPanel thread={thread} />
        </div>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ icon: Icon, title, sub }: { icon: React.ElementType; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground px-6 text-center">
      <Icon className="h-10 w-10 mb-3 opacity-25" />
      <p className="text-sm font-medium mb-1">{title}</p>
      <p className="text-xs opacity-70">{sub}</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type TabId = 'inbox' | 'sent' | 'marketing';

export default function Inbox() {
  const [activeTab, setActiveTab]   = useState<TabId>('inbox');
  const [selectedId, setSelectedId] = useState<string | null>(null); // conversation_id
  const [search, setSearch]         = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [isMarketingUser, setIsMarketingUser] = useState(false);

  // Check if current user is Chris (marketing tab gating)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.id === MARKETING_USER_ID) setIsMarketingUser(true);
    });
  }, []);

  // ── Inbox: inbound messages scoped to current user ──
  const { data: rawInbox = [], isLoading: inboxLoading } = useQuery({
    queryKey: ['inbox_msgs'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from('messages')
        .select(MSG_SELECT)
        .eq('direction', 'inbound')
        .eq('owner_id', user.id)
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map(flattenRow) as MsgRow[];
    },
  });

  // ── Sent: outbound messages scoped to current user ──
  const { data: rawSent = [], isLoading: sentLoading } = useQuery({
    queryKey: ['sent_msgs'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from('messages')
        .select(MSG_SELECT)
        .eq('direction', 'outbound')
        .eq('owner_id', user.id)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map(flattenRow) as MsgRow[];
    },
  });

  // ── Marketing: all messages for the marketing account (Chris only) ──
  const { data: rawMarketing = [], isLoading: mktLoading } = useQuery({
    queryKey: ['marketing_msgs'],
    enabled: isMarketingUser,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages')
        .select(MSG_SELECT)
        .eq('integration_account_id', MARKETING_ACCOUNT_ID)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map(flattenRow) as MsgRow[];
    },
  });

  // Deduplicate and filter by search
  const apply = (rows: MsgRow[]) => {
    const deduped = dedupeByConversation(rows);
    if (!search.trim()) return deduped;
    const q = search.toLowerCase();
    return deduped.filter(r =>
      r.candidate_name?.toLowerCase().includes(q) ||
      r.contact_name?.toLowerCase().includes(q) ||
      r.sender_name?.toLowerCase().includes(q) ||
      r.subject?.toLowerCase().includes(q) ||
      r.body?.toLowerCase().includes(q)
    );
  };

  const inboxRows    = useMemo(() => apply(rawInbox),    [rawInbox, search]);
  const sentRows     = useMemo(() => apply(rawSent),     [rawSent, search]);
  const marketingRows = useMemo(() => apply(rawMarketing), [rawMarketing, search]);

  const activeRows    = activeTab === 'inbox' ? inboxRows : activeTab === 'sent' ? sentRows : marketingRows;
  const activeLoading = activeTab === 'inbox' ? inboxLoading : activeTab === 'sent' ? sentLoading : mktLoading;

  const switchTab = (tab: TabId) => {
    setActiveTab(tab);
    setSelectedId(null);
    setSearch('');
  };

  const tabs: { id: TabId; label: string; Icon: React.ElementType; count?: number }[] = [
    { id: 'inbox',   label: 'Inbox',   Icon: Mail,  count: inboxRows.length },
    { id: 'sent',    label: 'Sent',    Icon: Send },
    ...(isMarketingUser ? [{ id: 'marketing' as TabId, label: 'Marketing', Icon: Linkedin }] : []),
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Inbox"
        description="All channels · Unified"
      />

      <ComposeMessageDialog open={composeOpen} onOpenChange={setComposeOpen} />

      <div className="flex" style={{ height: 'calc(100vh - 7rem)' }}>
        {/* ── Left panel ── */}
        <div className="w-96 border-r border-border flex flex-col bg-background">

          {/* Tab bar */}
          <div className="flex border-b border-border/60 px-1 pt-1">
            {tabs.map(({ id, label, Icon, count }) => (
              <button
                key={id}
                onClick={() => switchTab(id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
                  activeTab === id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {count !== undefined && count > 0 && (
                  <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent/15 text-accent text-[9px] font-bold px-1">
                    {count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Search + Compose */}
          <div className="p-3 border-b border-border/60 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search name, subject…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <Button variant="gold" size="icon" onClick={() => setComposeOpen(true)} className="h-8 w-8 shrink-0" title="Compose">
              <PenSquare className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* List */}
          <ScrollArea className="flex-1">
            {activeLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : activeRows.length === 0 ? (
              <EmptyState
                icon={activeTab === 'sent' ? Send : Mail}
                title={activeTab === 'sent' ? 'No sent messages' : 'No messages'}
                sub={search ? 'No results for your search' : activeTab === 'sent' ? 'Messages you send will appear here' : 'Incoming messages will appear here'}
              />
            ) : (
              <div>
                {activeRows.map((row) => (
                  <MsgListItem
                    key={row.id}
                    row={row}
                    isSelected={selectedId === row.conversation_id}
                    isSent={activeTab === 'sent'}
                    onClick={() => setSelectedId(row.conversation_id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* ── Right: thread detail ── */}
        <div className="flex-1 min-w-0">
          <MessagePane threadId={selectedId} />
        </div>
      </div>
    </MainLayout>
  );
}
