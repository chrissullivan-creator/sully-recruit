import { useRef, useState } from 'react';
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
import { invalidateCommsScope } from '@/lib/invalidate';
import {
  Mail, MessageSquare, Linkedin, Search, Loader2, Send,
  UserCheck, Users, X, Paperclip,
} from 'lucide-react';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { TemplatePickerPopover } from '@/components/templates/TemplatePickerPopover';

const MESSAGE_ATTACHMENTS_BUCKET = 'message-attachments';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PendingAttachment {
  id: string;
  file: File;
  storage_path?: string;
  uploading: boolean;
  error?: string;
}

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
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resetForm = () => {
    setChannel('email');
    setSearchQuery('');
    setSearchResults([]);
    setSelectedRecipient(null);
    setSubject('');
    setBody('');
    setSending(false);
    setPendingAttachments([]);
  };

  const handlePickFiles = () => fileInputRef.current?.click();

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    const accepted: PendingAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is too large (max 15 MB)`);
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file, uploading: true });
    }
    if (accepted.length === 0) return;
    setPendingAttachments((prev) => [...prev, ...accepted]);

    await Promise.all(
      accepted.map(async (pending) => {
        try {
          const safeBase = pending.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          // New conversations don't have an id yet — drop files under a
          // time-based "new/" prefix; send-message only cares about storage_path.
          const path = `new/${Date.now()}-${crypto.randomUUID()}-${safeBase}`;
          const { error } = await supabase.storage
            .from(MESSAGE_ATTACHMENTS_BUCKET)
            .upload(path, pending.file, {
              contentType: pending.file.type || 'application/octet-stream',
              upsert: false,
            });
          if (error) throw error;
          setPendingAttachments((prev) =>
            prev.map((p) => (p.id === pending.id ? { ...p, uploading: false, storage_path: path } : p))
          );
        } catch (err: any) {
          console.error('Attachment upload error:', err);
          setPendingAttachments((prev) =>
            prev.map((p) => (p.id === pending.id ? { ...p, uploading: false, error: err?.message || 'Upload failed' } : p))
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

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const q = searchQuery.trim();
    const [cRes, ctRes] = await Promise.all([
      // Plain people.email is gone — use primary_email (computed COALESCE
      // of work_email/personal_email) and alias it back to `email` so
      // downstream code doesn't have to change.
      supabase.from('people').select('id, full_name, email:primary_email, phone, linkedin_url, current_title, current_company').or(`full_name.ilike.%${q}%,primary_email.ilike.%${q}%`).limit(5),
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

  const hasUploadingAttachments = pendingAttachments.some((p) => p.uploading);
  const canSend =
    selectedRecipient &&
    getRecipientAddress() &&
    !hasUploadingAttachments &&
    (body.trim().length > 0 || pendingAttachments.some((p) => !!p.storage_path && !p.error));

  const handleSend = async () => {
    if (!canSend || !selectedRecipient) return;
    if (hasUploadingAttachments) {
      toast.error('Please wait for attachments to finish uploading');
      return;
    }
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

      // For contacts, try to find a linked candidate — if none, insert with contact_id only
      if (selectedRecipient.entity_type === 'contact') {
        delete convInsert.candidate_id;
        convInsert.contact_id = selectedRecipient.id;
      }

      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .insert(convInsert)
        .select('id')
        .single();

      if (convError) throw convError;

      // Resolve LinkedIn provider_id if needed
      let resolvedTo = toAddress;
      if (channel === 'linkedin') {
        const channelTable = selectedRecipient.entity_type === 'candidate' ? 'candidate_channels' : 'contact_channels';
        const idCol = selectedRecipient.entity_type === 'candidate' ? 'candidate_id' : 'contact_id';
        const { data: channelData } = await supabase
          .from(channelTable)
          .select('provider_id, unipile_id')
          .eq(idCol, selectedRecipient.id)
          .eq('channel', 'linkedin')
          .maybeSingle();
        if (channelData?.provider_id || channelData?.unipile_id) {
          resolvedTo = channelData.provider_id || channelData.unipile_id || toAddress;
        }
      }

      // Send via edge function
      const attachmentsPayload = pendingAttachments
        .filter((p) => !!p.storage_path && !p.error)
        .map((p) => ({
          name: p.file.name,
          storage_path: p.storage_path!,
          size: p.file.size,
          mime_type: p.file.type || 'application/octet-stream',
        }));

      const sendPayload: any = {
        channel,
        conversation_id: conv.id,
        to: resolvedTo,
        subject: channel === 'email' ? subject || undefined : undefined,
        body: body.trim(),
        attachments: attachmentsPayload.length > 0 ? attachmentsPayload : undefined,
      };
      if (selectedRecipient.entity_type === 'candidate') {
        sendPayload.candidate_id = selectedRecipient.id;
      } else {
        sendPayload.contact_id = selectedRecipient.id;
      }
      // supabase.functions.invoke expects { body } as the second arg.
      const { data, error } = await supabase.functions.invoke('send-message', { body: sendPayload });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Send failed');

      toast.success(`Message sent via ${channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'LinkedIn'}`);
      invalidateCommsScope(queryClient);
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

          {/* Attachments */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-muted-foreground">Attachments</Label>
              <button
                type="button"
                onClick={handlePickFiles}
                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                <Paperclip className="h-3 w-3" />
                Attach files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFilesSelected}
              />
            </div>
            {pendingAttachments.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70 italic">No files attached</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
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
                    <span className="text-[10px] text-muted-foreground">{formatBytes(p.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePendingAttachment(p.id)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
