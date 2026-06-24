import {
  Inbox as InboxIcon,
  Mail,
  Linkedin,
  MessageSquare,
  Target,
  Phone,
  Users,
  UserPlus,
  CornerDownLeft,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type InboxView =
  | 'all'
  | 'unread'
  | 'starred'
  | 'snoozed'
  | 'awaiting_reply'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'needs_classification'
  | 'need_respond';

export type InboxChannel = 'all' | 'email' | 'linkedin' | 'recruiter' | 'sms';

export interface InboxSidebarCounts {
  all?: number;
  unread?: number;
  starred?: number;
  snoozed?: number;
  awaiting_reply?: number;
  sent?: number;
  drafts?: number;
  archive?: number;
  needs_classification?: number;
}

export interface InboxScopeMember {
  userId: string;
  label: string;
}

export interface InboxSidebarProps {
  // Viewing Inbox (per-user scope) — rendered as a dropdown at the top of the
  // rail. Non-admins only ever see "My Inbox"; admins also get Team + members.
  isAdmin: boolean;
  scope: 'mine' | 'team';
  memberFilter: string;
  teamMembers: InboxScopeMember[];
  onScope: (s: 'mine' | 'team') => void;
  onMember: (userId: string) => void;
  currentUserLabel?: string;

  // Channels (with unread counts).
  channel: InboxChannel;
  channelCounts?: Partial<Record<InboxChannel, number>>;
  onSelectChannel: (channel: InboxChannel) => void;
  callsActive?: boolean;
  onSelectCalls?: () => void;

  // Views: People we know (focused) / Other (unlinked) / Need to respond.
  tab: 'focused' | 'other';
  tabCounts?: { focused?: number; other?: number };
  onSelectTab: (tab: 'focused' | 'other') => void;
  needRespondCount?: number;
  needRespondActive?: boolean;
  onSelectNeedRespond: () => void;

  footer?: React.ReactNode;
}

const CHANNEL_ITEMS: { key: InboxChannel; label: string; Icon: React.ElementType }[] = [
  { key: 'all', label: 'All Inbox', Icon: InboxIcon },
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin },
  { key: 'recruiter', label: 'InMail', Icon: Target },
  { key: 'sms', label: 'SMS', Icon: MessageSquare },
];

export function InboxSidebar({
  isAdmin,
  scope,
  memberFilter,
  teamMembers,
  onScope,
  onMember,
  currentUserLabel,
  channel,
  channelCounts = {},
  onSelectChannel,
  callsActive = false,
  onSelectCalls,
  tab,
  tabCounts = {},
  onSelectTab,
  needRespondCount,
  needRespondActive = false,
  onSelectNeedRespond,
  footer,
}: InboxSidebarProps) {
  // The scope dropdown encodes scope + member into one value: 'mine' shows the
  // recruiter's own inbox, 'team' shows everyone, and a userId picks one member.
  const scopeValue = scope === 'mine' ? 'mine' : memberFilter === 'all' ? 'team' : memberFilter;
  const onScopeChange = (val: string) => {
    if (val === 'mine') {
      onScope('mine');
    } else if (val === 'team') {
      onScope('team');
      onMember('all');
    } else {
      onScope('team');
      onMember(val);
    }
  };

  return (
    <aside className="w-52 shrink-0 border-r border-border/60 bg-muted/20 flex flex-col">
      <div className="flex-1 overflow-y-auto py-3 text-sm">
        {/* Viewing Inbox — per-user scope */}
        <SectionLabel>Viewing Inbox</SectionLabel>
        <div className="px-2 mb-1">
          <div className="relative">
            <select
              value={scopeValue}
              onChange={(e) => onScopeChange(e.target.value)}
              disabled={!isAdmin}
              aria-label="Viewing inbox"
              className={cn(
                'w-full appearance-none rounded-md border border-border bg-background pl-2.5 pr-7 py-1.5 text-xs font-medium text-foreground transition-colors',
                'focus:outline-none focus:ring-1 focus:ring-accent/40',
                isAdmin ? 'hover:border-accent/50 cursor-pointer' : 'opacity-90 cursor-default',
              )}
            >
              <option value="mine">My Inbox{currentUserLabel ? ` · ${currentUserLabel}` : ''}</option>
              {isAdmin && <option value="team">Team · everyone</option>}
              {isAdmin &&
                teamMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.label}
                  </option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </div>

        {/* Channels */}
        <SectionLabel className="mt-4">Channels</SectionLabel>
        <nav className="px-2 space-y-0.5">
          {CHANNEL_ITEMS.map((c) => (
            <NavRow
              key={c.key}
              label={c.label}
              Icon={c.Icon}
              count={channelCounts[c.key]}
              active={!callsActive && channel === c.key}
              onClick={() => onSelectChannel(c.key)}
            />
          ))}
          {onSelectCalls && (
            <NavRow label="Calls" Icon={Phone} active={callsActive} onClick={onSelectCalls} />
          )}
        </nav>

        {/* Views — People we know / Other / Need to respond. No section label. */}
        <nav className="px-2 space-y-0.5 mt-4">
          <NavRow
            label="People we know"
            Icon={Users}
            count={tabCounts.focused}
            active={!callsActive && !needRespondActive && tab === 'focused'}
            onClick={() => onSelectTab('focused')}
          />
          <NavRow
            label="Other"
            Icon={UserPlus}
            count={tabCounts.other}
            active={!callsActive && !needRespondActive && tab === 'other'}
            onClick={() => onSelectTab('other')}
          />
          <NavRow
            label="Need to respond"
            Icon={CornerDownLeft}
            count={needRespondCount}
            active={!callsActive && needRespondActive}
            onClick={onSelectNeedRespond}
          />
        </nav>
      </div>
      {footer ? <div className="p-2 border-t border-border/60">{footer}</div> : null}
    </aside>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80',
        className,
      )}
    >
      {children}
    </div>
  );
}

function NavRow({
  label,
  Icon,
  count,
  active,
  disabled,
  hint,
  onClick,
}: {
  label: string;
  Icon: React.ElementType;
  count?: number;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors',
        active && !disabled && 'bg-accent/12 text-foreground font-medium',
        !active && !disabled && 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
        disabled && 'text-muted-foreground/60 cursor-not-allowed',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', active && !disabled && 'text-accent')} />
      <span className="flex-1 truncate text-xs">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            'text-[10px] tabular-nums rounded px-1.5 py-0.5',
            active && !disabled ? 'bg-accent/20 text-accent font-semibold' : 'bg-muted text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
