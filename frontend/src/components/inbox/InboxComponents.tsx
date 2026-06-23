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
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils';
import { invalidateCommsScope } from '@/lib/invalidate';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Search, Mail, MessageSquare, Linkedin, Phone, Users,
  UserCheck, Send, Loader2, MoreVertical, Check,
  ChevronRight, Circle, CheckCircle2, AlertCircle, MapPin,
  Building, Link as LinkIcon, UserPlus, ArrowLeft, ArrowRight,
  PenSquare, Plus, Paperclip, X as XIcon, Trash2, UserRound,
  CheckSquare, Square, MailOpen, Archive, Rows3, Rows2,
  Star, Clock as ClockIcon, Bell, Sun, CalendarClock,
} from 'lucide-react';
import { authHeaders } from '@/lib/api-auth';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSmartTimestamp, formatAbsoluteTimestamp, formatThreadTimestamp, getDateGroup } from '@/lib/format-time';
import { useInboxDensity, type InboxDensity } from '@/lib/use-inbox-density';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Link, useSearchParams } from 'react-router-dom';
import { ComposeMessageDialog } from '@/components/inbox/ComposeMessageDialog';
import { UnknownPersonBadge } from '@/components/inbox/UnknownPersonBadge';
import { AddPersonWizard } from '@/components/inbox/AddPersonWizard';
import { InboxSidebar, type InboxView, type InboxChannel } from '@/components/inbox/InboxSidebar';
import { CallsPanel } from '@/components/calls/CallsPanel';
import { RecruiterContextStrip } from '@/components/inbox/RecruiterContextStrip';
import { EmailMessageCard } from '@/components/inbox/EmailMessageCard';
import { SnoozeMenu } from '@/components/inbox/SnoozeMenu';
import { FollowUpMenu } from '@/components/inbox/FollowUpMenu';
import { NeedsClassificationList } from '@/components/inbox/NeedsClassificationList';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { CallButton } from '@/components/shared/CallButton';
import { TemplatePickerPopover } from '@/components/templates/TemplatePickerPopover';
import {
  type MessageAttachment, type InboxThread, type Message,
  LINKEDIN_CHANNELS, CHANNEL_ICONS, CHANNEL_LABELS, CHANNEL_COLORS,
} from '@/components/inbox/inbox-shared';
import {
  stripEmailThread, getInitials, MESSAGE_ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES,
  formatBytes, resolveAttachmentUrl, uploadAttachment, loadDraft, saveDraft, clearDraft,
  type PendingAttachment,
} from '@/components/inbox/inbox-helpers';

// ---------- Date group header ----------
export function DateGroupHeader({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 px-3 py-1.5 bg-background/95 backdrop-blur border-b border-border/60">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

// ---------- Thread Item ----------
export function ThreadItem({
  thread,
  isSelected,
  isChecked,
  selectionActive,
  density,
  onClick,
  onToggleCheck,
  onToggleFlag,
  onToggleRead,
  onArchive,
  onSnooze,
  onUnsnooze,
}: {
  thread: InboxThread;
  isSelected: boolean;
  isChecked: boolean;
  selectionActive: boolean;
  density: InboxDensity;
  onClick: () => void;
  onToggleCheck: (shiftKey: boolean) => void;
  onToggleFlag: () => void | Promise<void>;
  onToggleRead: () => void | Promise<void>;
  onArchive: () => void | Promise<void>;
  onSnooze: (wakeAt: Date) => void | Promise<void>;
  onUnsnooze: () => void | Promise<void>;
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
  const isUnread = !thread.is_read;
  const compact = density === 'compact';

  return (
    <div
      className={cn(
        'group w-full text-left border-b border-border/60 hover:bg-muted/40 transition-colors relative cursor-pointer',
        compact ? 'px-3 py-2' : 'px-3 py-3.5',
        isSelected && 'bg-accent/8',
        isChecked && 'bg-accent/12',
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
      {/* Accent bar on left — full-row height, marks unread or selected */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 transition-colors',
          isSelected ? 'bg-accent' : isUnread ? 'bg-accent/70' : 'bg-transparent'
        )}
        aria-hidden
      />
      <div className="flex items-start gap-2 pl-1">
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
        <div className={cn(
          'mt-0.5 flex shrink-0 items-center justify-center rounded-full',
          compact ? 'h-7 w-7' : 'h-8 w-8',
          CHANNEL_COLORS[thread.channel] || 'bg-muted text-muted-foreground',
        )}>
          <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {entityName ? (
                <span className={cn(
                  'truncate',
                  compact ? 'text-sm' : 'text-[15px]',
                  isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/90',
                )}>
                  {entityName}
                </span>
              ) : (
                <span className={cn(
                  'font-medium italic flex items-center gap-1',
                  compact ? 'text-sm' : 'text-[15px]',
                  'text-muted-foreground',
                )}>
                  Unknown sender
                </span>
              )}
              {thread.has_attachments && (
                <Paperclip
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                  aria-label="Has attachments"
                />
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Persistent flag indicator — shown whenever flagged, even
                  not on hover */}
              {thread.flagged && (
                <Star className="h-3.5 w-3.5 fill-[#C9A84C] text-[#C9A84C] shrink-0" aria-label="Flagged" />
              )}
              {/* Hover actions — wired to handlers */}
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleFlag(); }}
                  className={cn(
                    'p-1 rounded hover:bg-muted',
                    thread.flagged ? 'text-[#C9A84C]' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={thread.flagged ? 'Unflag' : 'Flag'}
                  aria-label={thread.flagged ? 'Unflag' : 'Flag'}
                >
                  <Star className={cn('h-3.5 w-3.5', thread.flagged && 'fill-[#C9A84C]')} />
                </button>
                <SnoozeMenu
                  currentSnoozedUntil={thread.snoozed_until ?? null}
                  onSnooze={onSnooze}
                  onUnsnooze={onUnsnooze}
                  trigger={
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                      title="Snooze"
                      aria-label="Snooze"
                    >
                      <ClockIcon className="h-3.5 w-3.5" />
                    </button>
                  }
                />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleRead(); }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={thread.is_read ? 'Mark unread' : 'Mark read'}
                  aria-label={thread.is_read ? 'Mark unread' : 'Mark read'}
                >
                  <MailOpen className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onArchive(); }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={thread.is_archived ? 'Unarchive' : 'Archive'}
                  aria-label={thread.is_archived ? 'Unarchive' : 'Archive'}
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </div>
              {previewTime ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={cn(
                      'text-xs tabular-nums shrink-0 group-hover:hidden',
                      isUnread ? 'font-semibold text-foreground/80' : 'font-medium text-muted-foreground',
                    )}>
                      {formatSmartTimestamp(previewTime)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {formatAbsoluteTimestamp(previewTime)}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          {thread.subject && (
            <p className={cn(
              'truncate mb-0.5',
              compact ? 'text-xs' : 'text-sm',
              isUnread ? 'text-foreground font-semibold' : 'text-foreground/80 font-medium',
            )}>
              {thread.subject}
            </p>
          )}
          {!compact && (
            <p className="text-xs text-muted-foreground truncate">
              {awaitingReply ? (
                <span className="italic opacity-70">Awaiting reply…</span>
              ) : (
                previewText || '—'
              )}
            </p>
          )}
          {!compact && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <Badge variant="outline" className="text-[9px] uppercase h-4 px-1.5 tracking-wide">
                {CHANNEL_LABELS[thread.channel] || thread.channel}
              </Badge>
              {thread.id.startsWith('live:') && (
                <span
                  className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600 inline-flex items-center gap-1"
                  title="Live from Unipile — add the person to start tracking"
                >
                  Live
                </span>
              )}
              {thread.snoozed_until && new Date(thread.snoozed_until).getTime() > Date.now() && (
                <span
                  className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-[#7C3AED]/10 text-[#7C3AED] inline-flex items-center gap-1"
                  title={`Snoozed until ${formatAbsoluteTimestamp(thread.snoozed_until)}`}
                >
                  <ClockIcon className="h-2.5 w-2.5" />
                  Snoozed
                </span>
              )}
              {awaitingReply && !thread.snoozed_until && (
                <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  Awaiting reply
                </span>
              )}
              {!isLinked && (
                <span
                  className="text-[10px] text-muted-foreground/70"
                  title="No person linked"
                  aria-label="No person linked"
                >
                  ?
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ---------- Entity Info Panel ----------
export function EntityPanel({ thread, messages }: { thread: InboxThread | null; messages: Message[] }) {
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
              {((entity as any).personal_email || (entity as any).work_email || (entity as any).primary_email) && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">
                    {(entity as any).personal_email || (entity as any).work_email || (entity as any).primary_email}
                  </span>
                </div>
              )}
              {entity.phone && (
                <div className="flex items-center gap-2 text-xs text-foreground/80">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{entity.phone}</span>
                  <CallButton
                    phone={entity.phone}
                    candidateId={entityType === 'candidate' ? thread.candidate_id : null}
                    contactId={entityType === 'contact' ? thread.contact_id : null}
                    iconOnly
                    className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    title={`Call ${entity.phone} (RingCentral RingOut)`}
                  />
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

export function MessageAttachmentList({
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

export function MessagePane({ threadId, onDeleted }: { threadId: string | null; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const [replyHtml, setReplyHtml] = useState('');
  const [sending, setSending] = useState(false);
  const [showEntity, setShowEntity] = useState(true);
  const [deleting, setDeleting] = useState(false);
  // The signed-in recruiter's booking-link slug, so the reply composer can
  // insert a prefilled /book/{slug} URL. Fetched once; null = no link yet.
  const [bookingSlug, setBookingSlug] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/schedule-links', { headers: await authHeaders() });
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data.links) && data.links[0]?.active) {
          setBookingSlug(data.links[0].slug);
        }
      } catch {
        // no booking link configured — button stays hidden
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Restore the persisted draft when the thread changes. Sets the
  // contenteditable's innerHTML on the next tick so the React state +
  // DOM stay in sync.
  useEffect(() => {
    const draft = loadDraft(threadId);
    setReplyHtml(draft?.html ?? '');
    setReplyText(draft?.text ?? '');
    requestAnimationFrame(() => {
      if (editorRef.current) editorRef.current.innerHTML = DOMPurify.sanitize(draft?.html ?? '');
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

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

  // Clear the "just woke from snooze" banner once the user opens the thread.
  // The DB column stays as audit; the UI banner only shows when it's recent
  // (< 1 day) AND we haven't dismissed it in this session.
  const [wakeDismissed, setWakeDismissed] = useState(false);
  useEffect(() => {
    setWakeDismissed(false);
  }, [threadId]);

  const handleSetFollowUp = async (followUpAt: Date) => {
    if (!threadId) return;
    const { error } = await supabase
      .from('conversations')
      .update({
        follow_up_at: followUpAt.toISOString(),
        follow_up_at_set_at: new Date().toISOString(),
        follow_up_triggered_at: null,
      } as any)
      .eq('id', threadId);
    if (error) {
      toast.error(`Couldn't set reminder: ${error.message}`);
      return;
    }
    toast.success('Reminder set');
    invalidateCommsScope(queryClient);
  };

  const handleClearFollowUp = async () => {
    if (!threadId) return;
    const { error } = await supabase
      .from('conversations')
      .update({
        follow_up_at: null,
        follow_up_at_set_at: null,
        follow_up_triggered_at: null,
      } as any)
      .eq('id', threadId);
    if (error) {
      toast.error(`Couldn't clear reminder: ${error.message}`);
      return;
    }
    toast.success('Reminder cleared');
    invalidateCommsScope(queryClient);
  };

  const handleDismissWake = async () => {
    if (!threadId) return;
    setWakeDismissed(true);
    await supabase
      .from('conversations')
      .update({ woke_from_snooze_at: null } as any)
      .eq('id', threadId);
    invalidateCommsScope(queryClient);
  };

  // Auto-mark-read shortly after a thread is opened. 600ms delay so a
  // misclick during quick scanning doesn't flip the state — long
  // enough to feel intentional, short enough to feel automatic.
  // Skips if already read or still loading.
  useEffect(() => {
    if (!threadId || !thread || thread.is_read) return;
    const t = window.setTimeout(() => {
      handleMarkRead();
    }, 600);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, thread?.is_read]);

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
      if (threadId) clearDraft(threadId);
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

  const isEmail = thread.channel === 'email';
  const personRole: 'candidate' | 'contact' | null = thread.candidate_id
    ? 'candidate'
    : thread.contact_id
      ? 'contact'
      : null;
  const personId = thread.candidate_id || thread.contact_id || null;
  const awaitingReply = !thread.last_inbound_at && !!thread.last_message_at;
  const lastMessageDirection = messages.length > 0 ? messages[messages.length - 1].direction : null;
  // Prefer the explicit conversations.status column (set by webhook
  // handlers + send-message in Phase 5). Fall back to the heuristic
  // derived from message history for legacy rows.
  const statusLabel = ((): 'Awaiting reply' | 'Replied' | 'Closed' | null => {
    switch (thread.status) {
      case 'awaiting_reply': return 'Awaiting reply';
      case 'replied': return 'Replied';
      case 'closed':
      case 'no_reply_needed': return 'Closed';
      case 'snoozed': return null; // handled by the snoozed pill elsewhere
    }
    if (awaitingReply) return 'Awaiting reply';
    if (lastMessageDirection === 'inbound') return 'Replied';
    return null;
  })();

  return (
    <div className="flex h-full">
      {/* Messages */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Sticky header zone: identity bar + subject + recruiter strip */}
        <div className="sticky top-0 z-20 bg-background border-b border-border">
          {/* Identity bar */}
          <div className="px-6 py-3 flex items-center gap-3">
            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', CHANNEL_COLORS[thread.channel] || 'bg-muted text-muted-foreground')}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
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
                {statusLabel && (
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded shrink-0',
                      statusLabel === 'Awaiting reply' && 'bg-muted text-muted-foreground',
                      statusLabel === 'Replied' && 'bg-success/15 text-success',
                      statusLabel === 'Closed' && 'bg-muted/50 text-muted-foreground',
                    )}
                  >
                    {statusLabel}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!thread.is_read && (
                <Button variant="ghost" size="sm" onClick={handleMarkRead} className="text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Read
                </Button>
              )}
              <FollowUpMenu
                currentFollowUp={thread.follow_up_at ?? null}
                onSet={handleSetFollowUp}
                onClear={handleClearFollowUp}
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    title={thread.follow_up_at ? 'Edit follow-up reminder' : 'Remind me if no reply'}
                    className={thread.follow_up_at ? 'text-accent' : ''}
                  >
                    <Bell className="h-4 w-4" />
                  </Button>
                }
              />
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

          {/* Prominent subject line — the email-channel header. For chat
              channels it's still useful when a subject is set (e.g. linked
              send-out), but it's smaller. */}
          {thread.subject && (
            <div className="px-6 pb-3">
              <h1 className={cn(
                'text-foreground font-semibold truncate',
                isEmail ? 'text-lg' : 'text-sm',
              )}>
                {thread.subject}
              </h1>
            </div>
          )}

          {/* Recruiter context strip — appears when linked */}
          {personId && personRole && (
            <RecruiterContextStrip personId={personId} role={personRole} />
          )}
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

        {/* Wake-from-snooze banner — shows when the cron fired in the last
            24h and the user hasn't dismissed it in this session. */}
        {!wakeDismissed && thread.woke_from_snooze_at && (Date.now() - new Date(thread.woke_from_snooze_at).getTime()) < 24 * 60 * 60 * 1000 && (
          <div className="px-6 py-2.5 bg-[#7C3AED]/5 border-b border-[#7C3AED]/20 flex items-center gap-2">
            <Sun className="h-3.5 w-3.5 text-[#7C3AED] shrink-0" />
            <p className="text-xs text-[#7C3AED] flex-1">
              <span className="font-medium">Welcome back —</span> this thread woke from snooze {formatSmartTimestamp(thread.woke_from_snooze_at)}.
            </p>
            <button
              type="button"
              onClick={handleDismissWake}
              className="text-xs text-[#7C3AED] hover:text-[#7C3AED]/80"
              title="Dismiss"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Follow-up triggered banner — shows when the reminder fired
            because no reply came in. Cleared when user dismisses or sets
            a new reminder. */}
        {thread.follow_up_triggered_at && !thread.follow_up_at && (Date.now() - new Date(thread.follow_up_triggered_at).getTime()) < 7 * 24 * 60 * 60 * 1000 && (
          <div className="px-6 py-2.5 bg-accent/5 border-b border-accent/20 flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-accent shrink-0" />
            <p className="text-xs text-accent flex-1">
              <span className="font-medium">Follow-up reminder —</span> no reply received since you set this.
            </p>
            <button
              type="button"
              onClick={handleClearFollowUp}
              className="text-xs text-accent hover:text-accent/80"
              title="Dismiss"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
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
          ) : isEmail ? (
            /* Email layout — Outlook-style cards. Latest expanded, older
               messages collapsed. Date separators between days. */
            <div className="max-w-3xl mx-auto space-y-3">
              {messages.map((msg, idx) => {
                const msgTime = msg.sent_at || msg.received_at || msg.created_at;
                const msgDate = getDateKey(msg);
                const prevDate = idx > 0 ? getDateKey(messages[idx - 1]) : null;
                const showDateSep = msgDate !== prevDate;
                const isLatest = idx === messages.length - 1;
                return (
                  <div key={msg.id}>
                    {showDateSep && (
                      <div className="flex items-center gap-3 py-3">
                        <div className="flex-1 h-px bg-border/60" />
                        <span className="text-[11px] font-semibold text-muted-foreground tracking-wide">
                          {getDateGroup(msgTime).label === 'Today' || getDateGroup(msgTime).label === 'Yesterday'
                            ? getDateGroup(msgTime).label
                            : format(new Date(msgTime), 'EEEE, MMMM d')}
                        </span>
                        <div className="flex-1 h-px bg-border/60" />
                      </div>
                    )}
                    <EmailMessageCard
                      message={msg}
                      defaultExpanded={isLatest}
                      entityName={entityName}
                      stripQuoted={stripEmailThread}
                      attachmentsSlot={
                        msg.attachments && (msg.attachments as MessageAttachment[]).length > 0 ? (
                          <div className="mt-3">
                            <MessageAttachmentList
                              attachments={msg.attachments}
                              isOutbound={msg.direction === 'outbound'}
                            />
                          </div>
                        ) : undefined
                      }
                    />
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
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

                // Outbound sender initials from sender_name
                const outboundInitials = getInitials(msg.sender_name || 'You');
                // Inbound initials from sender or entity name
                const inboundInitials = getInitials(msg.sender_name || entityName);

                return (
                  <div key={msg.id}>
                    {/* Date divider — smart format: Today / Yesterday / weekday / full date */}
                    {showDateSep && (
                      <div className="flex items-center gap-3 py-4 my-2">
                        <div className="flex-1 h-px bg-border/60" />
                        <span className="text-[11px] font-semibold text-muted-foreground tracking-wide">
                          {getDateGroup(msgTime).label === 'Today' || getDateGroup(msgTime).label === 'Yesterday'
                            ? getDateGroup(msgTime).label
                            : format(new Date(msgTime), 'EEEE, MMMM d')}
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
                              ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(displayBody) }} className="prose prose-sm max-w-none [&_*]:text-inherit [&_a]:underline" />
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
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-[10px] text-muted-foreground/70 cursor-default">
                                  {formatThreadTimestamp(msgTime)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                {formatAbsoluteTimestamp(msgTime)}
                              </TooltipContent>
                            </Tooltip>
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
                    const text = tmp.textContent || '';
                    setReplyText(text);
                    if (threadId) saveDraft(threadId, html, text);
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
                    const text = tmp.textContent || '';
                    setReplyText(text);
                    if (editorRef.current) editorRef.current.innerHTML = DOMPurify.sanitize(template.body);
                    if (threadId) saveDraft(threadId, template.body, text);
                  }}
                />
                {bookingSlug && (
                  <Button
                    variant="outline"
                    size="icon"
                    title="Insert booking link"
                    className="h-[36px] w-[36px]"
                    onClick={() => {
                      const origin = window.location.origin;
                      const qs = new URLSearchParams();
                      if (personId) qs.set('person', personId);
                      if (senderName) qs.set('name', senderName);
                      if (senderAddress.includes('@')) qs.set('email', senderAddress);
                      const q = qs.toString();
                      const url = `${origin}/book/${bookingSlug}${q ? `?${q}` : ''}`;
                      const linkHtml = `<a href="${url}">Book a time with me</a>`;
                      const nextHtml = replyHtml ? `${replyHtml}<br/>${linkHtml}` : linkHtml;
                      setReplyHtml(nextHtml);
                      const tmp = document.createElement('div');
                      tmp.innerHTML = nextHtml;
                      const text = tmp.textContent || '';
                      setReplyText(text);
                      if (editorRef.current) editorRef.current.innerHTML = DOMPurify.sanitize(nextHtml);
                      if (threadId) saveDraft(threadId, nextHtml, text);
                    }}
                  >
                    <CalendarClock className="h-4 w-4" />
                  </Button>
                )}
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
          senderProviderId={thread.channel?.startsWith('linkedin') && !senderAddress.includes('linkedin.com') ? senderAddress : undefined}
          onPersonLinked={() => {
            invalidateCommsScope(queryClient);
          }}
        />
      )}
    </div>
  );
}

// ---------- Bulk Action Bar ----------
export function BulkActionBar({
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
