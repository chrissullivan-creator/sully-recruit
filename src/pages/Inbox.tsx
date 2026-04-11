import { useState } from 'react';
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
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Target, Send, Loader2, MoreVertical,
  ChevronRight, Circle, CheckCircle2, AlertCircle, MapPin,
  Building, Link as LinkIcon, UserPlus, ArrowLeft, ArrowRight,
  PenSquare, Trash2,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
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

// ---------- Entity Info Panel ----------
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
      const { data, error } = await supabase.from('notes').select('*').eq('entity_id', thread!.candidate_id!).eq('entity_type', 'candidate').order('created_at', { ascending: false }).limit(5);
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
          Linked Record
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
              <p className="text-xs text-warning leading-relaxed">
                This conversation is not linked to any record. Search to link it manually.
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Search name…"
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="h-8 text-xs"
              />
              <Button size="sm" variant="outline" onClick={handleSearch} disabled={linkSearching} className="h-8 px-2">
                {linkSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
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
                        {r.entity_type} · {r.current_title || r.title || ''}
                      </p>
                    </div>
                    <LinkIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            )}
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
    </div>
  );
}

// ---------- Message Detail ----------
function MessagePane({ threadId, onDeleted }: { threadId: string | null; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEntity, setShowEntity] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteThread = async () => {
    if (!threadId) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('conversations').delete().eq('id', threadId);
      if (error) { toast.error(error.message || 'Failed to delete thread'); return; }
      toast.success('Conversation deleted');
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      onDeleted?.();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete thread');
    } finally {
      setDeleting(false);
    }
  };

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
          <EntityPanel thread={thread} />
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
                placeholder="Search messages, names…"
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
          <MessagePane threadId={selectedId} onDeleted={() => setSelectedId(null)} />
        </div>
      </div>
    </MainLayout>
  );
}
