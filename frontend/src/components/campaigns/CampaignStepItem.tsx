import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Mail, MessageSquare, Phone, Linkedin, Users, Trash2, Clock, Timer, Sun, Reply, PenLine, Send, Sparkles, Loader2 } from 'lucide-react';
import { StepAttachments, type Attachment } from './StepAttachments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CampaignStep, ChannelType } from '@/types';

const channelOptions: { value: ChannelType; label: string; icon: React.ReactNode }[] = [
  { value: 'linkedin_recruiter', label: 'LinkedIn Recruiter InMail', icon: <Linkedin className="h-4 w-4" /> },
  { value: 'linkedin_message', label: 'LinkedIn Message', icon: <MessageSquare className="h-4 w-4" /> },
  { value: 'linkedin_connection', label: 'Connection Request', icon: <Users className="h-4 w-4" /> },
  { value: 'email', label: 'Email', icon: <Mail className="h-4 w-4" /> },
  { value: 'sms', label: 'SMS', icon: <MessageSquare className="h-4 w-4" /> },
  { value: 'phone', label: 'Phone Call', icon: <Phone className="h-4 w-4" /> },
];

const hourOptions = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`,
}));

const channelPlaceholders: Partial<Record<ChannelType, string>> = {
  linkedin_recruiter: 'InMail message body...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.',
  linkedin_message: 'LinkedIn message...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.',
  linkedin_connection: 'Connection request note (max 300 chars)...',
  email: 'Type your email here in plain text...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.\n\nYour signature will be added automatically if enabled.',
  sms: 'SMS text (keep under 160 chars for single message)...',
  phone: 'Call script / talking points:\n\n1. Introduction\n2. Value proposition\n3. Ask / next steps',
};

interface IntegrationAccount {
  id: string;
  account_type: string;
  provider: string;
  account_label: string | null;
  is_active: boolean;
  owner_user_id?: string | null;
}

interface CampaignStepItemProps {
  step: CampaignStep;
  index: number;
  allSteps: CampaignStep[];
  accounts: IntegrationAccount[];
  onUpdate: (id: string, updates: Partial<CampaignStep>) => void;
  onDelete: (id: string) => void;
  jobTitle?: string;
  jobCompany?: string;
  sequenceName?: string;
  sequenceDescription?: string;
}

const isLinkedInChannel = (ch: ChannelType) =>
  ['linkedin_recruiter', 'linkedin_message', 'linkedin_connection'].includes(ch);

const needsSubject = (ch: ChannelType) =>
  ['linkedin_recruiter', 'email'].includes(ch);


export const CampaignStepItem = ({ step, index, allSteps, accounts, onUpdate, onDelete, jobTitle, jobCompany, sequenceName, sequenceDescription }: CampaignStepItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const channelInfo = channelOptions.find(c => c.value === step.channel);
  const showConnectionWait = step.channel === 'linkedin_message';
  const isEmail = step.channel === 'email';

  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [askJoeLoading, setAskJoeLoading] = useState(false);

  const handleAskJoe = async () => {
    setAskJoeLoading(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');

      const channelLabel = channelOptions.find(c => c.value === step.channel)?.label ?? step.channel;
      const prompt = `Write a ${channelLabel} message for step ${index + 1} of ${allSteps.length}. Channel: ${channelLabel}.${jobTitle ? ` Job: ${jobTitle}${jobCompany ? ` at ${jobCompany}` : ''}.` : ''}${sequenceName ? ` Sequence: ${sequenceName}.` : ''}${sequenceDescription ? ` Sequence description: "${sequenceDescription}".` : ''} Return ONLY the message body, no preamble.`;

      const resp = await fetch(`${supabaseUrl}/functions/v1/ask-joe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey,
        },
        body: JSON.stringify({
          mode: 'draft_message',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!resp.ok) throw new Error(`Joe returned ${resp.status}`);

      // Read SSE stream
      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Parse SSE lines: "data: {...}\n\n"
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.content) fullContent += parsed.content;
            } catch { /* skip non-JSON lines */ }
          }
        }
      }

      if (!fullContent.trim()) throw new Error('Joe returned an empty response');

      let content = fullContent.trim();
      let subject = step.subject;

      // Parse subject from response if it's a first-touch email
      if (step.channel === 'email' && !step.isReply && content.startsWith('Subject:')) {
        const lines = content.split('\n');
        subject = lines[0].replace('Subject:', '').trim();
        content = lines.slice(1).join('\n').trim();
      }

      onUpdate(step.id, { content, ...(subject ? { subject } : {}) });
      toast.success('Joe wrote your message');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate content');
    } finally {
      setAskJoeLoading(false);
    }
  };

  const insertAtCursor = (token: string) => {
    if (contentRef.current) {
      const el = contentRef.current;
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const newText = step.content.slice(0, start) + token + step.content.slice(end);
      onUpdate(step.id, { content: newText });
      setTimeout(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      }, 0);
    } else {
      onUpdate(step.id, { content: step.content + token });
    }
  };
  // Deduplicate accounts by owner — show each person once regardless of channel
  const activeAccounts = accounts.filter(a => a.is_active);
  const seenOwners = new Set<string>();
  const senderAccounts = activeAccounts.filter(a => {
    const key = a.owner_user_id || a.id;
    if (seenOwners.has(key)) return false;
    seenOwners.add(key);
    return true;
  });

  /** Strip channel suffixes like "Email", "LinkedIn", etc. from account labels */
  const senderLabel = (acc: IntegrationAccount) => {
    const label = acc.account_label || `${acc.provider} – ${acc.account_type}`;
    return label.replace(/\s*(Email|LinkedIn|SMS|Phone|SMTP|Gmail|Outlook)\s*$/i, '').trim() || label;
  };

  // Find previous email step's subject for reply context
  const prevEmailStep = allSteps
    .slice(0, index)
    .reverse()
    .find(s => s.channel === 'email');
  const replySubject = prevEmailStep?.subject ? `Re: ${prevEmailStep.subject}` : 'Re: (previous email)';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border border-border bg-card p-4 transition-all',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-accent'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Drag Handle */}
        <button
          {...attributes}
          {...listeners}
          className="mt-1 cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-5 w-5" />
        </button>

        {/* Step Number */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground text-sm font-semibold">
          {index + 1}
        </div>

        {/* Step Content */}
        <div className="flex-1 space-y-3">
          {/* Row 1: Channel + Sender + Delete */}
          <div className="flex items-center gap-3 flex-wrap">
            <Select
              value={step.channel}
              onValueChange={(value: ChannelType) => {
                if (value === 'linkedin_message') {
                  const hasConnectionBefore = allSteps.slice(0, index).some(s => s.channel === 'linkedin_connection');
                  if (!hasConnectionBefore) {
                    toast.error('A Connection Request step must come before a LinkedIn Message step.');
                    return;
                  }
                }
                const updates: Partial<CampaignStep> = { channel: value, accountId: undefined };
                if (value === 'email') {
                  updates.useSignature = true;
                  const hasPrevEmail = allSteps.slice(0, index).some(s => s.channel === 'email');
                  updates.isReply = hasPrevEmail;
                } else {
                  updates.useSignature = false;
                  updates.isReply = false;
                }
                onUpdate(step.id, updates);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue>
                  <div className="flex items-center gap-2">
                    {channelInfo?.icon}
                    <span>{channelInfo?.label}</span>
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {channelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center gap-2">
                      {option.icon}
                      <span>{option.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Sender / Account picker */}
            <Select
              value={step.accountId || '_none'}
              onValueChange={(v) => onUpdate(step.id, { accountId: v === '_none' ? undefined : v })}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue>
                  <div className="flex items-center gap-2 text-sm">
                    <Send className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>
                      {step.accountId
                        ? senderLabel(accounts.find(a => a.id === step.accountId) || { account_label: 'Selected account', provider: '', account_type: '', id: '', is_active: true })
                        : 'Select sender'}
                    </span>
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">
                  <span className="text-muted-foreground">Auto (default account)</span>
                </SelectItem>
                {senderAccounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {senderLabel(acc)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Channel-specific badges */}
            {isEmail && step.isReply && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                <Reply className="h-3 w-3" />
                Reply
              </span>
            )}
            {isEmail && step.useSignature && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                <PenLine className="h-3 w-3" />
                Signature
              </span>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(step.id)}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          {/* LinkedIn message without prior connection warning */}
          {step.channel === 'linkedin_message' && !allSteps.slice(0, index).some(s => s.channel === 'linkedin_connection') && (
            <div className="flex items-center gap-2 rounded-md border border-[#C9A86A]/30 bg-[#C9A86A]/10 px-3 py-2 text-xs text-[#9A7B3F]">
              <span>⚠️</span>
              <span>No connection request step found before this message. Add one or this step will be skipped for non-connections.</span>
            </div>
          )}

          {/* Row 2: Timing controls */}
          <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Wait</Label>
              <Input
                type="number"
                min={index === 0 ? 0 : 1}
                value={step.delayDays}
                onChange={(e) => onUpdate(step.id, { delayDays: parseInt(e.target.value) || 0 })}
                className="w-16 h-8 text-sm"
              />
              <span className="text-xs text-muted-foreground">days</span>
              <Input
                type="number"
                min={0}
                max={23}
                value={step.delayHours}
                onChange={(e) => {
                  const val = Math.min(23, Math.max(0, parseInt(e.target.value) || 0));
                  onUpdate(step.id, { delayHours: val });
                }}
                className="w-16 h-8 text-sm"
              />
              <span className="text-xs text-muted-foreground">hrs</span>
            </div>

            <div className="flex items-center gap-2">
              <Sun className="h-4 w-4 text-muted-foreground shrink-0" />
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Send between</Label>
              <Select
                value={String(step.sendWindowStart)}
                onValueChange={(v) => {
                  const start = parseInt(v);
                  onUpdate(step.id, {
                    sendWindowStart: start,
                    sendWindowEnd: Math.max(start + 1, step.sendWindowEnd),
                  });
                }}
              >
                <SelectTrigger className="w-[90px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.filter(h => parseInt(h.value) >= 6 && parseInt(h.value) <= 20).map((h) => (
                    <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">–</span>
              <Select
                value={String(step.sendWindowEnd)}
                onValueChange={(v) => onUpdate(step.id, { sendWindowEnd: parseInt(v) })}
              >
                <SelectTrigger className="w-[90px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.filter(h => parseInt(h.value) > step.sendWindowStart && parseInt(h.value) <= 21).map((h) => (
                    <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground opacity-50">(business hours)</span>
            </div>
          </div>

          {/* Row 3: LinkedIn connection wait */}
          {showConnectionWait && (
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
              <Timer className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex items-center gap-2 flex-1">
                <Switch
                  checked={step.waitForConnection}
                  onCheckedChange={(checked) => onUpdate(step.id, { waitForConnection: checked })}
                />
                <Label className="text-xs text-muted-foreground">Wait for connection acceptance</Label>
              </div>
              {step.waitForConnection && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Min wait</Label>
                  <Input
                    type="number"
                    min={4}
                    value={step.minHoursAfterConnection}
                    onChange={(e) => onUpdate(step.id, { minHoursAfterConnection: Math.max(4, parseInt(e.target.value) || 4) })}
                    className="w-16 h-8 text-sm"
                  />
                  <span className="text-xs text-muted-foreground">hrs</span>
                </div>
              )}
            </div>
          )}

          {/* Email-specific controls */}
          {isEmail && (
            <div className="space-y-3">
              <div className="flex items-center gap-6 rounded-md border border-border bg-muted/30 p-3">
                {prevEmailStep && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`reply-${step.id}`}
                      checked={step.isReply}
                      onCheckedChange={(checked) => onUpdate(step.id, { isReply: !!checked })}
                    />
                    <Label htmlFor={`reply-${step.id}`} className="text-xs text-muted-foreground cursor-pointer">
                      Reply to previous email
                    </Label>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`sig-${step.id}`}
                    checked={step.useSignature}
                    onCheckedChange={(checked) => onUpdate(step.id, { useSignature: !!checked })}
                  />
                  <Label htmlFor={`sig-${step.id}`} className="text-xs text-muted-foreground cursor-pointer">
                    Include email signature
                  </Label>
                </div>
              </div>

              {step.isReply ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 border border-border rounded-md px-3 py-2">
                  <Reply className="h-3.5 w-3.5 shrink-0" />
                  <span>Subject: <span className="font-medium text-foreground">{replySubject}</span></span>
                </div>
              ) : (
                <Input
                  placeholder="Email subject line..."
                  value={step.subject || ''}
                  onChange={(e) => onUpdate(step.id, { subject: e.target.value })}
                />
              )}
            </div>
          )}

          {/* LinkedIn InMail subject line */}
          {needsSubject(step.channel) && !isEmail && (
            <Input
              placeholder="InMail subject line..."
              value={step.subject || ''}
              onChange={(e) => onUpdate(step.id, { subject: e.target.value })}
            />
          )}

          {/* Content */}
          {/* personalization helpers */}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => insertAtCursor('{{first_name}}')}
            >
              Insert first name
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => handleAskJoe()}
              disabled={askJoeLoading}
              className="gap-1 text-accent border-accent/30 hover:bg-accent/10"
            >
              {askJoeLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {askJoeLoading ? 'Writing...' : 'Ask Joe'}
            </Button>
          </div>
          <RichTextEditor
            value={step.content}
            onChange={(html) => onUpdate(step.id, { content: html })}
            placeholder={channelPlaceholders[step.channel] || 'Message content...'}
            minHeight="80px"
          />

          {/* Attachments */}
          {(step.channel === 'email' || step.channel === 'linkedin_recruiter') && (
            <StepAttachments
              stepId={step.id}
              attachments={step.attachments ?? []}
              onAttachmentsChange={(attachments) => onUpdate(step.id, { attachments })}
            />
          )}

          {/* SMS character counter */}
          {step.channel === 'sms' && (
            <p className={cn(
              'text-xs text-right',
              step.content.length > 160 ? 'text-destructive' : 'text-muted-foreground'
            )}>
              {step.content.length}/160 characters {step.content.length > 160 ? `(${Math.ceil(step.content.length / 160)} segments)` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
