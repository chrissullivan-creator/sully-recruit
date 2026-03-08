import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Mail, MessageSquare, Phone, Linkedin, Users, Trash2, Clock, Timer, Sun, Reply, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { CampaignStep, ChannelType } from '@/types';

const channelOptions: { value: ChannelType; label: string; icon: React.ReactNode }[] = [
  { value: 'linkedin_recruiter', label: 'LinkedIn Recruiter InMail', icon: <Linkedin className="h-4 w-4" /> },
  { value: 'sales_nav', label: 'Sales Nav InMail', icon: <Linkedin className="h-4 w-4" /> },
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
  sales_nav: 'Sales Navigator InMail body...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.',
  linkedin_message: 'LinkedIn message...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.',
  linkedin_connection: 'Connection request note (max 300 chars)...',
  email: 'Email body...\n\nUse {{first_name}}, {{company}}, {{title}} for personalization.\n\nSignature will be appended automatically.',
  sms: 'SMS text (keep under 160 chars for single message)...',
  phone: 'Call script / talking points:\n\n1. Introduction\n2. Value proposition\n3. Ask / next steps',
};

interface CampaignStepItemProps {
  step: CampaignStep;
  index: number;
  allSteps: CampaignStep[];
  onUpdate: (id: string, updates: Partial<CampaignStep>) => void;
  onDelete: (id: string) => void;
}

const isLinkedInChannel = (ch: ChannelType) =>
  ['linkedin_recruiter', 'sales_nav', 'linkedin_message', 'linkedin_connection'].includes(ch);

const needsSubject = (ch: ChannelType) =>
  ['linkedin_recruiter', 'sales_nav', 'email'].includes(ch);

export const CampaignStepItem = ({ step, index, allSteps, onUpdate, onDelete }: CampaignStepItemProps) => {
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
  const showConnectionWait = isLinkedInChannel(step.channel) && step.channel !== 'linkedin_connection';
  const isEmail = step.channel === 'email';

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
          {/* Row 1: Channel + Delete */}
          <div className="flex items-center gap-3">
            <Select
              value={step.channel}
              onValueChange={(value: ChannelType) => {
                const updates: Partial<CampaignStep> = { channel: value };
                // Auto-set defaults when switching to email
                if (value === 'email') {
                  updates.useSignature = true;
                  // Check if there's a previous email step
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

          {/* Row 2: Timing controls */}
          <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Wait</Label>
              <Input
                type="number"
                min={0}
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
                  {hourOptions.filter(h => parseInt(h.value) < 23).map((h) => (
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
                  {hourOptions.filter(h => parseInt(h.value) > step.sendWindowStart).map((h) => (
                    <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              {/* Reply / Signature toggles */}
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

              {/* Subject line */}
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
          <Textarea
            placeholder={channelPlaceholders[step.channel] || 'Message content...'}
            value={step.content}
            onChange={(e) => onUpdate(step.id, { content: e.target.value })}
            className="min-h-[80px] resize-none"
          />

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
