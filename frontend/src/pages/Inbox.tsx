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
import type { TablesUpdate } from '@/integrations/supabase/types';
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
import { DateGroupHeader, ThreadItem, MessagePane, BulkActionBar } from '@/components/inbox/InboxComponents';
import { useInboxScope } from '@/components/inbox/use-inbox-scope';
import { SENTIMENT_BUCKETS, sentimentBucketKey } from '@/components/shared/SentimentChip';


export default function Inbox() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  // URL-synced state for sidebar nav: ?tab=all|focused|other &view=unread|archive|... &channel=email|...
  // "All" is the default (no ?tab) so unlinked recruiter InMails — which land
  // unfocused — aren't hidden behind the People-we-know view.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'all' | 'focused' | 'other' =
    searchParams.get('tab') === 'other'
      ? 'other'
      : searchParams.get('tab') === 'focused'
        ? 'focused'
        : 'all';
  const view: InboxView = ((): InboxView => {
    const v = searchParams.get('view');
    const valid: InboxView[] = ['all', 'unread', 'starred', 'snoozed', 'awaiting_reply', 'sent', 'drafts', 'archive', 'needs_classification', 'need_respond'];
    return (valid as string[]).includes(v ?? '') ? (v as InboxView) : 'all';
  })();
  const channel: InboxChannel = ((): InboxChannel => {
    const c = searchParams.get('channel');
    const valid: InboxChannel[] = ['all', 'email', 'linkedin', 'recruiter', 'sms'];
    return (valid as string[]).includes(c ?? '') ? (c as InboxChannel) : 'all';
  })();
  // Sentiment filter (bucket key from SENTIMENT_BUCKETS, or 'all').
  const sentimentFilter: string = ((): string => {
    const s = searchParams.get('sentiment');
    return SENTIMENT_BUCKETS.some((b) => b.key === s) ? (s as string) : 'all';
  })();
  // Calls is a sibling Hub section tracked via ?section=calls, independent of
  // the view/channel message filters. When active, the Hub swaps the thread
  // list/detail for the embedded CallsPanel.
  const callsActive = searchParams.get('section') === 'calls';
  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };
  // Selecting a normal view/channel always leaves the Calls section.
  const updateChannelParam = (value: string | null) => {
    const next = new URLSearchParams(searchParams);
    next.delete('section');
    if (!value || value === 'all') next.delete('channel');
    else next.set('channel', value);
    setSearchParams(next, { replace: true });
  };
  const selectCalls = () => {
    const next = new URLSearchParams(searchParams);
    next.set('section', 'calls');
    setSearchParams(next, { replace: true });
  };
  // All / People we know (focused) / Other (unlinked) now live in the rail.
  // Selecting one always leaves the Calls section. "all" is the default, so it
  // clears the param; focused/other set it explicitly.
  const selectTab = (t: 'all' | 'focused' | 'other') => {
    const next = new URLSearchParams(searchParams);
    next.delete('section');
    next.delete('view'); // leaving the Need-to-respond view
    if (t === 'all') next.delete('tab');
    else next.set('tab', t);
    setSearchParams(next, { replace: true });
  };
  // "Need to respond" — known people whose latest message is inbound and still
  // unanswered. Lives in the rail's Views group, next to the focused/other tabs.
  const selectNeedRespond = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('section');
    next.set('view', 'need_respond');
    setSearchParams(next, { replace: true });
  };
  // Switching scope (mine/team/member) drops the Need-to-respond view so the
  // rail falls back to a normal People-we-know/Other highlight for the new
  // scope instead of leaving a filtered view with no tab selected.
  const exitNeedRespond = () => {
    if (view !== 'need_respond') return;
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    setSearchParams(next, { replace: true });
  };
  // Bulk-select state: thread IDs the user has checked. The toolbar
  // appears whenever this is non-empty. lastCheckedId enables shift-click
  // range selection on long inbox lists.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [density, setDensity] = useInboxDensity();
  const queryClient = useQueryClient();

  // Per-user scoping (threads + live "Other" tab + embedded Calls). Everyone
  // defaults to their own communications; admins can switch to Team / a member.
  const {
    ready: scopeReady,
    userId,
    isAdmin,
    teamMembers,
    scope,
    setScope,
    memberFilter,
    setMemberFilter,
    scopedAccountIds,
  } = useInboxScope();


  // Live fetch from Unipile for the "Other" + "All" tabs — only fires when the
  // user is viewing a tab that surfaces unknown senders. Returns threads from
  // unknown senders that we don't persist under the Phase 5 storage rule.
  const liveChannel = channel === 'all' ? 'linkedin' : channel;
  const { data: liveData } = useQuery({
    queryKey: ['inbox_live_threads', liveChannel, scope, memberFilter],
    enabled: (tab === 'other' || tab === 'all') && !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token || '';
      const qs = new URLSearchParams({ channel: liveChannel, limit: '100' });
      // Mirror the inbox scope so the live unknown-sender fetch matches the
      // visible threads. The endpoint re-verifies admin server-side.
      if (scope === 'team') {
        qs.set('scope', 'team');
        if (memberFilter !== 'all') qs.set('member', memberFilter);
      }
      const res = await fetch(`/api/inbox/live-threads?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { items: [] };
      return res.json();
    },
  });
  const liveThreads: InboxThread[] = ((liveData?.items ?? []) as Array<{
    id: string;
    channel: string;
    subject: string | null;
    last_message_at: string | null;
    last_message_preview: string | null;
    sender_name: string | null;
    account_id?: string | null;
    external_conversation_id: string | null;
    integration_account_id: string | null;
  }>).map((it) => ({
    id: it.id,
    channel: it.channel,
    subject: it.subject,
    last_message_at: it.last_message_at,
    last_message_preview: it.last_message_preview,
    last_inbound_at: it.last_message_at,
    last_inbound_preview: it.last_message_preview,
    sort_at: it.last_message_at,
    is_read: true, // live results aren't tracked unread/read
    is_archived: false,
    candidate_id: null,
    candidate_name: null,
    contact_id: null,
    contact_name: null,
    // Unknown live senders aren't linked to a CRM person — surface the Unipile
    // attendee name through sender_name so the row shows it (and stays styled
    // as unlinked) rather than masquerading as a known candidate.
    sender_name: it.sender_name,
    avatar_url: null,
    send_out_id: null,
    account_id: it.account_id ?? null,
    external_conversation_id: it.external_conversation_id,
    integration_account_id: it.integration_account_id,
  }));

  const { data: allThreads = [], isLoading } = useQuery({
    queryKey: ['inbox_threads', scope, memberFilter, scopedAccountIds],
    enabled: scopeReady,
    queryFn: async () => {
      // Scope every user to their own integration accounts (admins: Team =
      // no filter, or a selected member). [] → nothing in scope; null → no
      // filter (admin Team/All, incl. legacy null-account threads).
      if (scopedAccountIds !== null && scopedAccountIds.length === 0) return [];
      let query = supabase
        .from('inbox_threads').select('*')
        // sort_at = COALESCE(last_inbound_at, last_message_at), so threads
        // bubble up when a new inbound arrives, not when we reply.
        .order('sort_at', { ascending: false, nullsFirst: false });
      if (scopedAccountIds !== null) {
        query = query.in('integration_account_id', scopedAccountIds);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as InboxThread[];
    },
  });

  // The query is already scoped to the active inbox view, so everything
  // downstream (counts, tab split, view/channel/search filters) builds on it.
  const scoped = allThreads;

  // Helper: is this thread currently snoozed (wake-time in the future)?
  const isCurrentlySnoozed = (t: InboxThread) =>
    !!t.snoozed_until && new Date(t.snoozed_until).getTime() > Date.now();

  // Snoozed threads are hidden from every view EXCEPT the Snoozed view itself
  // and the Archive view. Archived threads are hidden from every view except
  // the Archive view.
  const visibleByDefault = (t: InboxThread) => !isCurrentlySnoozed(t) && !t.is_archived;

  // Focused = threads tagged to a person in the CRM. Other = unlinked.
  // Both tabs exclude snoozed + archived by default; the Snoozed and Archive
  // views below opt in explicitly.
  const sortBySortAtDesc = (a: InboxThread, b: InboxThread) => {
    const ta = a.sort_at ? new Date(a.sort_at).getTime() : 0;
    const tb = b.sort_at ? new Date(b.sort_at).getTime() : 0;
    return tb - ta;
  };

  const focusedThreads = scoped.filter((t) => (t.candidate_id || t.contact_id) && visibleByDefault(t));
  const persistedOther = scoped.filter((t) => !t.candidate_id && !t.contact_id && visibleByDefault(t));
  // The Other + All tabs union persisted unlinked threads with live-fetched
  // unknown-sender threads from Unipile. Live results are deduped by
  // external_conversation_id on the API side.
  const showLive = tab === 'other' || tab === 'all';
  const otherThreads: InboxThread[] = showLive
    ? [...persistedOther, ...liveThreads].sort(sortBySortAtDesc)
    : persistedOther;
  // "All" = everything: known people + unlinked + live unknown senders, so no
  // recruiter InMail is ever hidden behind a tab.
  const allTabThreads: InboxThread[] = [...focusedThreads, ...otherThreads].sort(sortBySortAtDesc);
  const tabPool = tab === 'all' ? allTabThreads : tab === 'focused' ? focusedThreads : otherThreads;

  // "Need to respond": known-person threads where the latest message is inbound
  // (from them) and we haven't replied since.
  const needRespondThreads = focusedThreads.filter((t) => {
    if (!t.last_inbound_at) return false;
    if (!t.last_outbound_at) return true;
    return new Date(t.last_inbound_at).getTime() > new Date(t.last_outbound_at).getTime();
  });

  const filtered = (() => {
    // The Snoozed and Archive views ignore the Focused/Other split — they
    // pull from the full team-scoped set since the user wants to see them
    // regardless of tagging.
    let pool: InboxThread[];
    if (view === 'need_respond') {
      pool = needRespondThreads;
    } else if (view === 'snoozed') {
      pool = scoped.filter(isCurrentlySnoozed);
    } else if (view === 'archive') {
      pool = scoped.filter((t) => t.is_archived);
    } else if (view === 'starred') {
      pool = scoped.filter((t) => t.flagged && visibleByDefault(t));
    } else if (view === 'sent') {
      // Every thread where we've sent at least one outbound message.
      pool = scoped.filter((t) => !!t.last_outbound_at && visibleByDefault(t));
    } else {
      pool = tabPool;
    }

    return pool.filter((t) => {
      // Channel filter
      if (channel === 'email' && t.channel !== 'email') return false;
      if (channel === 'sms' && t.channel !== 'sms') return false;
      if (channel === 'linkedin' && !(LINKEDIN_CHANNELS as readonly string[]).includes(t.channel)) return false;
      if (channel === 'recruiter' && t.channel !== 'linkedin_recruiter') return false;

      // View filter (only the views that aren't already pool-defined above)
      if (view === 'unread' && t.is_read) return false;
      if (view === 'awaiting_reply' && !(!t.last_inbound_at && !!t.last_message_at)) return false;
      // Views not yet backed by data — render empty list:
      if (view === 'drafts') return false;

      // Sentiment filter (bucketed)
      if (sentimentFilter !== 'all' && sentimentBucketKey(t.sentiment) !== sentimentFilter) return false;

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
  })();

  const unreadCount = scoped.filter((t) => !t.is_read && visibleByDefault(t)).length;

  // Per-channel unread badges for the rail's Channels section.
  const channelUnread: Partial<Record<InboxChannel, number>> = {
    all: unreadCount,
    email: scoped.filter((t) => t.channel === 'email' && !t.is_read && visibleByDefault(t)).length,
    linkedin: scoped.filter((t) => t.channel === 'linkedin' && !t.is_read && visibleByDefault(t)).length,
    recruiter: scoped.filter((t) => t.channel === 'linkedin_recruiter' && !t.is_read && visibleByDefault(t)).length,
    sms: scoped.filter((t) => t.channel === 'sms' && !t.is_read && visibleByDefault(t)).length,
  };

  // Title shown above the thread list.
  const listTitle =
    view === 'need_respond'
      ? 'Need to respond'
      : tab === 'all'
        ? 'All'
        : tab === 'focused'
          ? 'People we know'
          : 'Other';

  // Mutation helpers — used by the per-row hover actions.
  const updateThread = async (threadId: string, patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from('conversations')
      .update(patch as TablesUpdate<'conversations'>)
      .eq('id', threadId);
    if (error) {
      toast.error(`Update failed: ${error.message}`);
      return;
    }
    invalidateCommsScope(queryClient);
  };

  const handleToggleFlag = (t: InboxThread) =>
    updateThread(t.id, { flagged: !t.flagged });
  const handleToggleRead = (t: InboxThread) =>
    updateThread(t.id, { is_read: !t.is_read });
  const handleArchive = (t: InboxThread) =>
    updateThread(t.id, { is_archived: !t.is_archived });
  const handleSnooze = (t: InboxThread, wakeAt: Date) =>
    updateThread(t.id, { snoozed_until: wakeAt.toISOString(), status: 'snoozed' });
  const handleUnsnooze = (t: InboxThread) =>
    updateThread(t.id, { snoozed_until: null, status: null });

  return (
    <MainLayout>
      <PageHeader
        title="Communication Hub"
        description={
          callsActive
            ? (scope === 'team' ? 'Calls · Team' : 'Calls · Yours')
            : unreadCount > 0
              ? `${unreadCount} unread · ${scope === 'team' ? 'Team' : 'Your inbox'}`
              : `${scope === 'team' ? 'Team' : 'Your inbox'} · All channels`
        }
      />

      <ComposeMessageDialog open={composeOpen} onOpenChange={setComposeOpen} />

      <div className="flex flex-col" style={{ height: 'calc(100vh - 7rem)' }}>
        <div className="flex flex-1 min-h-0">
        {/* Left rail — Viewing Inbox (scope), Channels, People we know / Other, Filters */}
        <InboxSidebar
          isAdmin={isAdmin}
          scope={scope}
          memberFilter={memberFilter}
          teamMembers={teamMembers}
          onScope={(s) => { exitNeedRespond(); setScope(s); }}
          onMember={(m) => { exitNeedRespond(); setMemberFilter(m); }}
          channel={channel}
          channelCounts={channelUnread}
          onSelectChannel={(c) => updateChannelParam(c)}
          callsActive={callsActive}
          onSelectCalls={selectCalls}
          tab={tab}
          tabCounts={{
            all: focusedThreads.length + persistedOther.length,
            focused: focusedThreads.length,
            other: persistedOther.length,
          }}
          onSelectTab={selectTab}
          needRespondCount={needRespondThreads.length}
          needRespondActive={view === 'need_respond'}
          onSelectNeedRespond={selectNeedRespond}
        />

        {callsActive ? (
          /* Calls section — replaces the thread list + message pane with the
             shared CallsPanel (single source of truth with the /calls page). */
          <div className="flex-1 min-w-0">
            <CallsPanel embedded />
          </div>
        ) : (
        <>
        {/* Thread list */}
        <div className="w-80 border-r border-border flex flex-col bg-background">
          {/* Search + Density toggle + Compose */}
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDensity(density === 'comfortable' ? 'compact' : 'comfortable')}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Toggle list density"
                >
                  {density === 'comfortable' ? (
                    <Rows3 className="h-3.5 w-3.5" />
                  ) : (
                    <Rows2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {density === 'comfortable' ? 'Switch to compact' : 'Switch to comfortable'}
              </TooltipContent>
            </Tooltip>
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

          {/* List header — active view, count, and quick filters (Awaiting +
              Sentiment). The People-we-know / Other split now lives in the rail. */}
          <div className="px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-border/40">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground truncate">{listTitle}</div>
              <div className="text-[11px] text-muted-foreground">
                {filtered.length} conversation{filtered.length === 1 ? '' : 's'}
              </div>
            </div>
            <select
              value={sentimentFilter}
              onChange={(e) => updateParam('sentiment', e.target.value)}
              className="h-7 text-[11px] rounded-md border border-border bg-background px-1.5 text-muted-foreground hover:text-foreground hover:border-accent/50 transition-colors cursor-pointer"
              aria-label="Filter by sentiment"
            >
              <option value="all">All sentiment</option>
              {SENTIMENT_BUCKETS.map((b) => (
                <option key={b.key} value={b.key}>{b.label}</option>
              ))}
            </select>
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
                  .update({ is_read: true })
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
                  .update({ is_read: false })
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
                  .update({ is_archived: true })
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
            {view === 'needs_classification' ? (
              <NeedsClassificationList />
            ) : isLoading ? (
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
                {(() => {
                  // Render with sticky date-group headers. Threads are
                  // already sorted by sort_at desc upstream; we just emit
                  // a header whenever the bucket changes.
                  const now = new Date();
                  let lastBucket: string | null = null;
                  const items: React.ReactNode[] = [];
                  filtered.forEach((thread) => {
                    const ts = thread.last_inbound_at ?? thread.last_message_at;
                    const group = getDateGroup(ts, now);
                    if (group.key !== lastBucket) {
                      items.push(
                        <DateGroupHeader key={`hdr-${group.key}-${group.label}`} label={group.label} />,
                      );
                      lastBucket = group.key;
                    }
                    items.push(
                      <ThreadItem
                        key={thread.id}
                        thread={thread}
                        density={density}
                        isSelected={selectedId === thread.id}
                        isChecked={checkedIds.has(thread.id)}
                        selectionActive={checkedIds.size > 0}
                        onClick={() => {
                          if (thread.id.startsWith('live:')) {
                            toast.info(
                              'This thread is live from Unipile. Add the sender to your CRM to view + reply.',
                            );
                            return;
                          }
                          setSelectedId(thread.id);
                        }}
                        onToggleFlag={() => handleToggleFlag(thread)}
                        onToggleRead={() => handleToggleRead(thread)}
                        onArchive={() => handleArchive(thread)}
                        onSnooze={(wakeAt) => handleSnooze(thread, wakeAt)}
                        onUnsnooze={() => handleUnsnooze(thread)}
                        onToggleCheck={(shiftKey) => {
                          const next = new Set(checkedIds);
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
                      />,
                    );
                  });
                  return items;
                })()}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right: Message pane */}
        <div className="flex-1 min-w-0">
          <MessagePane threadId={selectedId} onDeleted={() => setSelectedId(null)} />
        </div>
        </>
        )}
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
                } catch (err) {
                  toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
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
