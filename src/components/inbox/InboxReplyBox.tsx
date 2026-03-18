import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Send, Loader2, Mail, MessageSquare, Linkedin } from 'lucide-react';

interface MessageLike {
  id: string;
  conversation_id: string;
  direction: string;
  channel: string;
  subject?: string | null;
  body?: string | null;
  sender_address?: string | null;
  recipient_address?: string | null;
  created_at: string;
  candidate_id?: string | null;
  [key: string]: unknown;
}

export interface InboxReplyBoxProps {
  threadId: string;
  channel: string;
  integrationAccountId: string | null;
  candidateId: string | null;
  messages: MessageLike[];
  emailLastMessageId?: string | null;
  emailThreadSubject?: string | null;
  onSent?: () => void;
}

const CHANNEL_META: Record<string, {
  label: string;
  placeholder: string;
  Icon: React.ElementType;
  iconClass: string;
  ringClass: string;
  badgeClass: string;
}> = {
  email: {
    label: 'Email',
    placeholder: 'Write your email reply…',
    Icon: Mail,
    iconClass: 'text-emerald-600',
    ringClass: 'focus:ring-emerald-400/40',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800',
  },
  linkedin: {
    label: 'LinkedIn',
    placeholder: 'Write your LinkedIn message…',
    Icon: Linkedin,
    iconClass: 'text-blue-600',
    ringClass: 'focus:ring-blue-400/40',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
  },
  linkedin_recruiter: {
    label: 'LinkedIn Recruiter',
    placeholder: 'Write your LinkedIn Recruiter message…',
    Icon: Linkedin,
    iconClass: 'text-blue-600',
    ringClass: 'focus:ring-blue-400/40',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
  },
  linkedin_sales_nav: {
    label: 'LinkedIn Sales Nav',
    placeholder: 'Write your Sales Navigator message…',
    Icon: Linkedin,
    iconClass: 'text-blue-600',
    ringClass: 'focus:ring-blue-400/40',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
  },
  sms: {
    label: 'SMS',
    placeholder: 'Write your text message…',
    Icon: MessageSquare,
    iconClass: 'text-amber-600',
    ringClass: 'focus:ring-amber-400/40',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800',
  },
};

const fallbackMeta = CHANNEL_META['email'];

export function InboxReplyBox({
  threadId,
  channel,
  integrationAccountId,
  candidateId,
  messages,
  emailLastMessageId,
  emailThreadSubject,
  onSent,
}: InboxReplyBoxProps) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const meta = CHANNEL_META[channel] ?? fallbackMeta;
  const Icon = meta.Icon;

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound') ?? null;

  const handleSend = useCallback(async () => {
    if (!body.trim() || sending) return;
    setSending(true);

    try {
      // Base payload — field names match send-reply edge function contract
      const payload: Record<string, unknown> = {
        conversation_id: threadId,
        candidate_id: candidateId,
        channel,
        integration_account_id: integrationAccountId,
        message_body: body.trim(),
      };

      if (channel === 'email') {
        // Threading: prefer enrollment fields, fall back to last message
        payload.reply_to_message_id = emailLastMessageId ?? lastMessage?.id ?? null;
        const rawSubject = emailThreadSubject ?? lastMessage?.subject ?? null;
        if (rawSubject) {
          const s = String(rawSubject);
          payload.thread_subject = s.toLowerCase().startsWith('re:') ? s : `Re: ${s}`;
        }
        if (lastInbound?.sender_address) {
          payload.to = lastInbound.sender_address;
        }

      } else if (channel === 'linkedin' || channel === 'linkedin_recruiter' || channel === 'linkedin_sales_nav') {
        // Prefer chat id on the message row; fall back to candidate_channels lookup
        const chatId = lastMessage?.unipile_chat_id ?? lastMessage?.chat_id ?? null;
        if (chatId) {
          payload.unipile_chat_id = chatId;
        } else if (candidateId) {
          const { data: ch } = await supabase
            .from('candidate_channels')
            .select('provider_id, unipile_id, chat_id')
            .eq('candidate_id', candidateId)
            .eq('channel', 'linkedin')
            .maybeSingle();
          if (ch) payload.unipile_chat_id = ch.chat_id ?? ch.unipile_id ?? ch.provider_id;
        }

      } else if (channel === 'sms') {
        // Phone number of the other party
        payload.recipient_address =
          lastInbound?.sender_address ??
          lastMessage?.recipient_address ??
          null;
      }

      const { data, error } = await supabase.functions.invoke('send-reply', { body: payload });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error ?? 'Send failed');

      toast.success(`Reply sent via ${meta.label}`);
      setBody('');
      textareaRef.current?.focus();
      onSent?.();
    } catch (err: any) {
      console.error('[InboxReplyBox] send error:', err);
      toast.error(err.message ?? 'Failed to send reply');
    } finally {
      setSending(false);
    }
  }, [body, sending, threadId, channel, candidateId, integrationAccountId,
      lastMessage, lastInbound, emailLastMessageId, emailThreadSubject, meta.label, onSent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border bg-background px-4 pt-3 pb-4 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-3.5 w-3.5', meta.iconClass)} />
        <span className="text-xs text-muted-foreground">Reply via</span>
        <Badge variant="outline" className={cn('text-[10px] h-5 px-2 py-0 font-medium', meta.badgeClass)}>
          {meta.label}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground select-none">⌘↵ to send</span>
      </div>

      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          placeholder={meta.placeholder}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={sending}
          className={cn(
            'flex-1 rounded-lg border border-input bg-background text-foreground text-sm px-3 py-2 resize-none',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
            meta.ringClass,
            sending && 'opacity-60 cursor-not-allowed'
          )}
        />
        <Button
          variant="gold"
          onClick={handleSend}
          disabled={sending || !body.trim()}
          className="h-[76px] w-11 px-0 shrink-0"
          title="Send (⌘↵)"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
