import { Mail, Linkedin, Target, MessageSquare, Inbox as InboxIcon, Phone, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InboxChannel, InboxView } from '@/components/inbox/InboxSidebar';
import { SENTIMENT_BUCKETS } from '@/components/shared/SentimentChip';
import type { InboxTeamMember, InboxScope } from '@/components/inbox/use-inbox-scope';

// The Communication Hub control bar — sits above the rail/list/conversation
// panes. Consolidates the cross-cutting filters (scope, channel, sentiment,
// awaiting-reply) so the left rail can stay focused on saved views.

const CHANNEL_CHIPS: { key: InboxChannel; label: string; Icon: React.ElementType }[] = [
  { key: 'all', label: 'All', Icon: InboxIcon },
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'linkedin', label: 'LinkedIn', Icon: Linkedin },
  { key: 'recruiter', label: 'InMail', Icon: Target },
  { key: 'sms', label: 'SMS', Icon: MessageSquare },
];

export interface InboxTopBarProps {
  isAdmin: boolean;
  scope: InboxScope;
  onScope: (s: InboxScope) => void;
  memberFilter: string;
  onMember: (userId: string) => void;
  teamMembers: InboxTeamMember[];

  channel: InboxChannel;
  onChannel: (c: InboxChannel) => void;
  callsActive: boolean;
  onCalls: () => void;

  sentiment: string;
  onSentiment: (s: string) => void;

  view: InboxView;
  onToggleAwaiting: () => void;
}

export function InboxTopBar({
  isAdmin,
  scope,
  onScope,
  memberFilter,
  onMember,
  teamMembers,
  channel,
  onChannel,
  callsActive,
  onCalls,
  sentiment,
  onSentiment,
  view,
  onToggleAwaiting,
}: InboxTopBarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap border-b border-border/60 bg-muted/10 px-3 py-2">
      {/* Channel chips */}
      <div className="flex items-center gap-1">
        {CHANNEL_CHIPS.map((c) => {
          const active = !callsActive && channel === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onChannel(c.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              <c.Icon className="h-3.5 w-3.5" />
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onCalls}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            callsActive
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
          )}
        >
          <Phone className="h-3.5 w-3.5" />
          Calls
        </button>
      </div>

      <div className="flex-1" />

      {/* Awaiting-reply quick toggle */}
      <button
        type="button"
        onClick={onToggleAwaiting}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          view === 'awaiting_reply'
            ? 'bg-accent/15 text-accent'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
        )}
        title="Show only threads awaiting your reply"
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
        Awaiting
      </button>

      {/* Sentiment filter */}
      <select
        value={sentiment}
        onChange={(e) => onSentiment(e.target.value)}
        className="h-7 text-xs rounded-md border border-border bg-background px-2 text-muted-foreground hover:text-foreground hover:border-accent/50 transition-colors cursor-pointer"
        aria-label="Filter by sentiment"
      >
        <option value="all">All sentiment</option>
        {SENTIMENT_BUCKETS.map((b) => (
          <option key={b.key} value={b.key}>{b.label}</option>
        ))}
      </select>

      {/* Scope toggle — admins only */}
      {isAdmin && (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => onScope('mine')}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                scope === 'mine' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              My inbox
            </button>
            <button
              type="button"
              onClick={() => onScope('team')}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                scope === 'team' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Team
            </button>
          </div>
          {scope === 'team' && teamMembers.length > 0 && (
            <select
              value={memberFilter}
              onChange={(e) => onMember(e.target.value)}
              className="h-7 text-xs rounded-md border border-border bg-background px-2 text-muted-foreground hover:text-foreground hover:border-accent/50 transition-colors cursor-pointer"
              aria-label="Team member filter"
            >
              <option value="all">All team</option>
              {teamMembers.map((m) => (
                <option key={m.userId} value={m.userId}>{m.label}</option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
