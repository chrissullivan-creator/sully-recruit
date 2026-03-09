import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, UserPlus, Target, Send, Loader2, MoreVertical,
  ChevronRight, Circle, CheckCircle2, AlertCircle, Link as LinkIcon,
} from 'lucide-react';

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
  send_out_id: string | null;
}

const channelIcons = {
  email: Mail,
  sms: MessageSquare,
  linkedin: Linkedin,
  phone: Phone,
};

const channelLabels = {
  email: 'Email',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  phone: 'Phone',
};

function ThreadList({
  threads,
  selectedId,
  onSelect,
  searchQuery,
}: {
  threads: InboxThread[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchQuery: string;
}) {
  const filtered = threads.filter((t) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      t.subject?.toLowerCase().includes(q) ||
      t.last_message_preview?.toLowerCase().includes(q) ||
      t.candidate_name?.toLowerCase().includes(q) ||
      t.contact_name?.toLowerCase().includes(q)
    );
  });

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Mail className="h-12 w-12 mb-3 opacity-30" />
        <p className="text-sm">No conversations found</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {filtered.map((thread) => {
        const Icon = channelIcons[thread.channel as keyof typeof channelIcons] || Mail;
        const entityName = thread.candidate_name || thread.contact_name;
        const isSelected = selectedId === thread.id;

        return (
          <button
            key={thread.id}
            onClick={() => onSelect(thread.id)}
            className={cn(
              'w-full text-left px-4 py-3 hover:bg-accent/5 transition-colors relative',
              isSelected && 'bg-accent/10 border-l-2 border-accent',
              !thread.is_read && 'bg-muted/30'
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  thread.channel === 'email' && 'bg-info/10 text-info',
                  thread.channel === 'linkedin' && 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
                  thread.channel === 'sms' && 'bg-success/10 text-success',
                  thread.channel === 'phone' && 'bg-accent/10 text-accent'
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  {entityName ? (
                    <span className="text-sm font-medium text-foreground truncate">{entityName}</span>
                  ) : (
                    <span className="text-sm font-medium text-muted-foreground italic">Unknown</span>
                  )}
                  {!thread.is_read && (
                    <Circle className="h-2 w-2 fill-accent text-accent shrink-0" />
                  )}
                </div>
                {thread.subject && (
                  <p className="text-sm text-foreground/80 truncate mb-0.5">{thread.subject}</p>
                )}
                <p className="text-xs text-muted-foreground truncate">{thread.last_message_preview || 'No preview'}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground">
                    {thread.last_message_at
                      ? format(new Date(thread.last_message_at), 'MMM d, h:mm a')
                      : ''}
                  </span>
                  <Badge variant="outline" className="text-[10px] uppercase h-4 px-1.5">
                    {channelLabels[thread.channel as keyof typeof channelLabels] || thread.channel}
                  </Badge>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-2" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MessageDetail({ threadId }: { threadId: string | null }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  const { data: thread } = useQuery({
    queryKey: ['inbox_thread', threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('inbox_threads')
        .select('*')
        .eq('id', threadId!)
        .single();
      if (error) throw error;
      return data as InboxThread;
    },
  });

  const { data: messages = [] } = useQuery({
    queryKey: ['messages', threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', threadId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as Message[];
    },
  });

  const { data: candidate } = useQuery({
    queryKey: ['candidate', thread?.candidate_id],
    enabled: !!thread?.candidate_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', thread!.candidate_id!)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: contact } = useQuery({
    queryKey: ['contact', thread?.contact_id],
    enabled: !!thread?.contact_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, companies(name)')
        .eq('id', thread!.contact_id!)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const handleMarkRead = async () => {
    if (!threadId || thread?.is_read) return;
    await supabase.from('conversations').update({ is_read: true }).eq('id', threadId);
    queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
    queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || !threadId || !thread) return;
    setSending(true);
    try {
      // TODO: Call edge function to send message based on channel
      // For now, just show a toast
      toast.info('Reply functionality coming soon - will send via ' + thread.channel);
      setReplyText('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  if (!threadId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Mail className="h-16 w-16 mb-4 opacity-20" />
        <p className="text-sm">Select a conversation to view messages</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const Icon = channelIcons[thread.channel as keyof typeof channelIcons] || Mail;
  const entityName = thread.candidate_name || thread.contact_name || 'Unknown';
  const entity = candidate || contact;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div
              className={cn(
                'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                thread.channel === 'email' && 'bg-info/10 text-info',
                thread.channel === 'linkedin' && 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
                thread.channel === 'sms' && 'bg-success/10 text-success',
                thread.channel === 'phone' && 'bg-accent/10 text-accent'
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-base font-semibold text-foreground">{entityName}</h2>
                {thread.candidate_id && <Badge variant="outline" className="gap-1"><UserCheck className="h-3 w-3" />Candidate</Badge>}
                {thread.contact_id && <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" />Contact</Badge>}
              </div>
              {thread.subject && <p className="text-sm text-muted-foreground">{thread.subject}</p>}
              <Badge variant="secondary" className="mt-1 text-[10px] uppercase">
                {channelLabels[thread.channel as keyof typeof channelLabels] || thread.channel}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!thread.is_read && (
              <Button variant="outline" size="sm" onClick={handleMarkRead}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark Read
              </Button>
            )}
            <Button variant="ghost" size="icon">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-6">
        <div className="space-y-4 max-w-3xl">
          {messages.map((msg) => {
            const isInbound = msg.direction === 'inbound';
            return (
              <div
                key={msg.id}
                className={cn('flex', isInbound ? 'justify-start' : 'justify-end')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg p-4',
                    isInbound
                      ? 'bg-muted border border-border'
                      : 'bg-accent/10 border border-accent/20'
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-foreground">
                      {isInbound ? msg.sender_name || 'Sender' : 'You'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {msg.sent_at
                        ? format(new Date(msg.sent_at), 'MMM d, h:mm a')
                        : msg.received_at
                        ? format(new Date(msg.received_at), 'MMM d, h:mm a')
                        : format(new Date(msg.created_at), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  {msg.subject && thread.channel === 'email' && (
                    <p className="text-sm font-medium text-foreground mb-2">{msg.subject}</p>
                  )}
                  <p className="text-sm text-foreground whitespace-pre-wrap">{msg.body || '(No content)'}</p>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Reply box */}
      <div className="border-t border-border p-4">
        <div className="flex gap-2">
          <Input
            placeholder="Type your reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendReply();
              }
            }}
            className="flex-1"
          />
          <Button variant="gold" onClick={handleSendReply} disabled={sending || !replyText.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </div>
      </div>

      {/* Entity sidebar */}
      {entity && (
        <aside className="w-80 border-l border-border overflow-y-auto">
          <div className="p-6 space-y-4">
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                {thread.candidate_id ? 'Candidate' : 'Contact'} Details
              </h3>
              <div className="space-y-2 text-sm">
                {entity.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={`mailto:${entity.email}`} className="text-foreground hover:text-accent truncate">
                      {entity.email}
                    </a>
                  </div>
                )}
                {entity.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-foreground">{entity.phone}</span>
                  </div>
                )}
                {entity.linkedin_url && (
                  <div className="flex items-center gap-2">
                    <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />
                    <a
                      href={entity.linkedin_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground hover:text-accent truncate"
                    >
                      LinkedIn Profile
                    </a>
                  </div>
                )}
              </div>
            </div>
            {thread.candidate_id && candidate && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Current Role</h3>
                <p className="text-sm text-foreground">
                  {candidate.current_title || 'N/A'}
                  {candidate.current_company && ` at ${candidate.current_company}`}
                </p>
              </div>
            )}
            {thread.contact_id && contact && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Company</h3>
                <p className="text-sm text-foreground">{(contact as any).companies?.name || 'N/A'}</p>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

export default function Inbox() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState('all');

  const { data: allThreads = [], isLoading } = useQuery({
    queryKey: ['inbox_threads'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('inbox_threads')
        .select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as InboxThread[];
    },
  });

  const filteredThreads = allThreads.filter((t) => {
    if (filterTab === 'all') return true;
    if (filterTab === 'candidates') return !!t.candidate_id;
    if (filterTab === 'contacts') return !!t.contact_id;
    if (filterTab === 'prospects') return !t.candidate_id && !t.contact_id; // unlinked
    if (filterTab === 'email') return t.channel === 'email';
    if (filterTab === 'sms') return t.channel === 'sms';
    if (filterTab === 'linkedin') return t.channel === 'linkedin';
    return true;
  });

  const unreadCount = allThreads.filter((t) => !t.is_read).length;

  return (
    <MainLayout>
      <PageHeader
        title="Inbox"
        description={`Unified communication hub - ${unreadCount} unread`}
      />
      <div className="flex h-[calc(100vh-8rem)]">
        {/* Left panel: thread list */}
        <div className="w-96 border-r border-border flex flex-col">
          {/* Search */}
          <div className="p-4 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Filters */}
          <Tabs value={filterTab} onValueChange={setFilterTab} className="px-4 pt-3">
            <TabsList className="grid grid-cols-4 w-full">
              <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
              <TabsTrigger value="candidates" className="text-xs gap-1">
                <UserCheck className="h-3 w-3" />
              </TabsTrigger>
              <TabsTrigger value="contacts" className="text-xs gap-1">
                <Users className="h-3 w-3" />
              </TabsTrigger>
              <TabsTrigger value="prospects" className="text-xs gap-1">
                <Target className="h-3 w-3" />
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Tabs value={filterTab} onValueChange={setFilterTab} className="px-4 pt-2 pb-3">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="email" className="text-xs gap-1">
                <Mail className="h-3 w-3" />
              </TabsTrigger>
              <TabsTrigger value="sms" className="text-xs gap-1">
                <MessageSquare className="h-3 w-3" />
              </TabsTrigger>
              <TabsTrigger value="linkedin" className="text-xs gap-1">
                <Linkedin className="h-3 w-3" />
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Thread list */}
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ThreadList
                threads={filteredThreads}
                selectedId={selectedThreadId}
                onSelect={setSelectedThreadId}
                searchQuery={searchQuery}
              />
            )}
          </ScrollArea>
        </div>

        {/* Right panel: message detail */}
        <div className="flex-1">
          <MessageDetail threadId={selectedThreadId} />
        </div>
      </div>
    </MainLayout>
  );
}
