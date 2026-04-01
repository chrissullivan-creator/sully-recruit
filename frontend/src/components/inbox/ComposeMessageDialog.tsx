import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Mail, MessageSquare, Linkedin, Search, Loader2, Send,
  UserCheck, Users, X,
} from 'lucide-react';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { TemplatePickerPopover } from '@/components/templates/TemplatePickerPopover';

type Channel = 'email' | 'sms' | 'linkedin';

interface RecipientResult {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  entity_type: 'candidate' | 'contact';
  current_title?: string | null;
  current_company?: string | null;
  title?: string | null;
}

const CHANNELS: { key: Channel; label: string; Icon: React.ElementType; description: string }[] = [
  { key: 'email', label: 'Email', Icon: Mail, description: 'Send an email' },
  { key: 'sms', label: 'SMS', Icon: MessageSquare, description: 'Send a text message' },
  { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin, description: 'Send a LinkedIn message' },
];

export function ComposeMessageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Channel>('email');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecipientResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<RecipientResult | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const resetForm = () => {
    setChannel('email');
    setSearchQuery('');
    setSearchResults([]);
    setSelectedRecipient(null);
    setSubject('');
    setBody('');
    setSending(false);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const q = searchQuery.trim();
    const [cRes, ctRes] = await Promise.all([
      supabase.from('candidates').select('id, full_name, email, phone, linkedin_url, current_title, current_company').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(5),
      supabase.from('contacts').select('id, full_name, email, phone, linkedin_url, title').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(5),
    ]);
    setSearchResults([
      ...(cRes.data || []).map((r) => ({ ...r, entity_type: 'candidate' as const })),
      ...(ctRes.data || []).map((r) => ({ ...r, entity_type: 'contact' as const })),
    ]);
    setSearching(false);
  };

  const getRecipientAddress = (): string | null => {
    if (!selectedRecipient) return null;
    switch (channel) {
      case 'email': return selectedRecipient.email || null;
      case 'sms': return selectedRecipient.phone || null;
      case 'linkedin': return selectedRecipient.linkedin_url || null;
    }
  };

  const getAddressLabel = (): string => {
    const addr = getRecipientAddress();
    if (!addr) return `No ${channel === 'email' ? 'email' : channel === 'sms' ? 'phone' : 'LinkedIn'} on file`;
    return addr;
  };

  const canSend = selectedRecipient && body.trim() && getRecipientAddress();

  const handleSend = async () => {
    if (!canSend || !selectedRecipient) return;
    setSending(true);

    try {
      const toAddress = getRecipientAddress()!;

      // Create a conversation first
      const convInsert: any = {
        channel,
        candidate_id: selectedRecipient.entity_type === 'candidate' ? selectedRecipient.id : undefined,
        contact_id: selectedRecipient.entity_type === 'contact' ? selectedRecipient.id : undefined,
        subject: subject || null,
        is_read: true,
        last_message_at: new Date().toISOString(),
        last_message_preview: body.substring(0, 100),
      };

      // We need a candidate_id for conversations (required field)
      // If sending to a contact, we still need to provide candidate_id somehow
      // For now, if it's a contact, we'll skip candidate_id and let the DB handle it
      if (selectedRecipient.entity_type === 'contact') {
        // Conversations require candidate_id — create a placeholder approach
        // Actually, let's check the schema: candidate_id is NOT NULL
        // So we need to handle this. For contact-only, we'll need to find or skip.
        // For MVP, we'll only support candidates or require a linked candidate
        toast.error('Direct contact messaging requires a linked candidate. Coming soon!');
        setSending(false);
        return;
      }

      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .insert(convInsert)
        .select('id')
        .single();

      if (convError) throw convError;

      // Resolve LinkedIn provider_id if needed
      let resolvedTo = toAddress;
      if (channel === 'linkedin' && selectedRecipient.entity_type === 'candidate') {
        const { data: channelData } = await supabase
          .from('candidate_channels')
          .select('provider_id, unipile_id')
          .eq('candidate_id', selectedRecipient.id)
          .eq('channel', 'linkedin')
          .maybeSingle();
        if (channelData?.provider_id || channelData?.unipile_id) {
          resolvedTo = channelData.provider_id || channelData.unipile_id || toAddress;
        }
      }

      // Send via edge function
      const { data, error } = await supabase.functions.invoke('send-message', {
        body: {
          channel,
          conversation_id: conv.id,
          candidate_id: selectedRecipient.id,
          to: resolvedTo,
          subject: channel === 'email' ? subject || undefined : undefined,
          body: body.trim(),
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Send failed');

      toast.success(`Message sent via ${channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'LinkedIn'}`);
      queryClient.invalidateQueries({ queryKey: ['inbox_threads'] });
      resetForm();
      onOpenChange(false);
    } catch (err: any) {
      console.error('Compose send error:', err);
      toast.error(err.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Message</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Channel selector */}
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Channel</Label>
            <div className="flex gap-2">
              {CHANNELS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  onClick={() => setChannel(key)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
                    channel === key
                      ? 'bg-accent text-accent-foreground border-accent'
                      : 'border-border text-muted-foreground hover:border-accent/50 hover:text-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Recipient */}
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">To</Label>
            {selectedRecipient ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                  {selectedRecipient.full_name?.slice(0, 2).toUpperCase() || '??'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{selectedRecipient.full_name}</p>
                  <p className={cn('text-xs truncate', getRecipientAddress() ? 'text-muted-foreground' : 'text-destructive')}>
                    {getAddressLabel()}
                  </p>
                </div>
                <Badge variant="outline" className="text-[9px] capitalize shrink-0">
                  {selectedRecipient.entity_type}
                </Badge>
                <button onClick={() => { setSelectedRecipient(null); setSearchResults([]); }} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="Search by name or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="h-9 text-sm"
                  />
                  <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching} className="h-9 px-3">
                    {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {searchResults.length > 0 && (
                  <ScrollArea className="max-h-40">
                    <div className="rounded-lg border border-border overflow-hidden">
                      {searchResults.map((r) => (
                        <button
                          key={r.id + r.entity_type}
                          onClick={() => { setSelectedRecipient(r); setSearchResults([]); setSearchQuery(''); }}
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
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}
          </div>

          {/* Subject (email only) */}
          {channel === 'email' && (
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Subject</Label>
              <Input
                placeholder="Email subject..."
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
          )}

          {/* Body */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-muted-foreground">Message</Label>
              <TemplatePickerPopover
                channel={channel}
                onInsert={(template) => {
                  setBody(template.body);
                  if (template.subject && channel === 'email') setSubject(template.subject);
                }}
              />
            </div>
            <RichTextEditor
              value={body}
              onChange={setBody}
              placeholder={`Type your ${channel === 'email' ? 'email' : channel === 'sms' ? 'text message' : 'LinkedIn message'}...`}
              minHeight="120px"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={handleSend}
            disabled={!canSend || sending}
            className="gap-1.5"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
