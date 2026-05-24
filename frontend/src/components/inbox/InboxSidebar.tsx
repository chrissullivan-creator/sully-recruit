import {
  Inbox as InboxIcon,
  Mail,
  Linkedin,
  MessageSquare,
  Target,
  Star,
  Clock,
  CornerDownLeft,
  Send as SendIcon,
  FileEdit,
  Archive as ArchiveIcon,
  HelpCircle,
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
  | 'needs_classification';

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

interface NavItem {
  key: InboxView;
  label: string;
  Icon: React.ElementType;
  count?: number;
  // True for views whose backing data lands in a later phase. The button
  // still renders so the layout is final, but it's disabled with a hint.
  comingSoon?: boolean;
}

interface ChannelItem {
  key: InboxChannel;
  label: string;
  Icon: React.ElementType;
}

const CHANNEL_ITEMS: ChannelItem[] = [
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin },
  { key: 'recruiter', label: 'Recruiter', Icon: Target },
  { key: 'sms', label: 'SMS', Icon: MessageSquare },
];

export interface InboxSidebarProps {
  view: InboxView;
  channel: InboxChannel;
  counts: InboxSidebarCounts;
  onSelectView: (view: InboxView) => void;
  onSelectChannel: (channel: InboxChannel) => void;
  footer?: React.ReactNode;
}

export function InboxSidebar({
  view,
  channel,
  counts,
  onSelectView,
  onSelectChannel,
  footer,
}: InboxSidebarProps) {
  const navItems: NavItem[] = [
    { key: 'all', label: 'All', Icon: InboxIcon, count: counts.all },
    { key: 'unread', label: 'Unread', Icon: InboxIcon, count: counts.unread },
    { key: 'awaiting_reply', label: 'Awaiting reply', Icon: CornerDownLeft, count: counts.awaiting_reply },
    { key: 'starred', label: 'Starred', Icon: Star, count: counts.starred },
    { key: 'snoozed', label: 'Snoozed', Icon: Clock, count: counts.snoozed },
    { key: 'sent', label: 'Sent', Icon: SendIcon, count: counts.sent, comingSoon: true },
    { key: 'drafts', label: 'Drafts', Icon: FileEdit, count: counts.drafts, comingSoon: true },
    { key: 'archive', label: 'Archive', Icon: ArchiveIcon, count: counts.archive },
    {
      key: 'needs_classification',
      label: 'Needs classification',
      Icon: HelpCircle,
      count: counts.needs_classification,
      comingSoon: true,
    },
  ];

  return (
    <aside className="w-52 shrink-0 border-r border-border/60 bg-muted/20 flex flex-col">
      <div className="flex-1 overflow-y-auto py-3 text-sm">
        <SectionLabel>Inbox</SectionLabel>
        <nav className="px-2 space-y-0.5">
          {navItems.map((item) => (
            <NavRow
              key={item.key}
              label={item.label}
              Icon={item.Icon}
              count={item.count}
              active={view === item.key}
              disabled={item.comingSoon}
              onClick={() => onSelectView(item.key)}
              hint={item.comingSoon ? 'Coming soon' : undefined}
            />
          ))}
        </nav>

        <SectionLabel className="mt-4">Channels</SectionLabel>
        <nav className="px-2 space-y-0.5">
          <NavRow
            label="All channels"
            Icon={InboxIcon}
            active={channel === 'all'}
            onClick={() => onSelectChannel('all')}
          />
          {CHANNEL_ITEMS.map((c) => (
            <NavRow
              key={c.key}
              label={c.label}
              Icon={c.Icon}
              active={channel === c.key}
              onClick={() => onSelectChannel(c.key)}
            />
          ))}
        </nav>
      </div>
      {footer ? <div className="p-2 border-t border-border/60">{footer}</div> : null}
    </aside>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80', className)}>
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
