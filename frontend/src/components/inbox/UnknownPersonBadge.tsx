import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Mail, Linkedin, MessageSquare } from 'lucide-react';

interface UnknownPersonBadgeProps {
  senderName?: string;
  senderEmail?: string;
  senderPhone?: string;
  channel: string;
  onAdd: () => void;
}

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  linkedin: Linkedin,
  sms: MessageSquare,
};

/**
 * Inline badge shown where a contact/candidate name would normally appear.
 * Renders the sender's info + a green "Add" button to open the wizard.
 * Only shown for unlinked threads — the parent renders a normal name link for known people.
 */
export function UnknownPersonBadge({
  senderName,
  senderEmail,
  senderPhone,
  channel,
  onAdd,
}: UnknownPersonBadgeProps) {
  const displayName = senderName || senderEmail || senderPhone || 'Unknown';
  const secondaryInfo =
    channel === 'email' ? senderEmail :
    channel === 'sms' ? senderPhone :
    'LinkedIn';
  const Icon = CHANNEL_ICONS[channel] || Mail;

  return (
    <div className="inline-flex items-center gap-2.5 px-2 py-1.5 rounded-lg border border-dashed border-border bg-muted/30">
      {/* Avatar */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <span className="text-[10px] font-semibold">
          {displayName.slice(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Info */}
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-semibold text-foreground truncate leading-tight">
          {displayName}
        </span>
        {secondaryInfo && secondaryInfo !== displayName && (
          <span className="text-[10px] text-muted-foreground truncate leading-tight flex items-center gap-1">
            <Icon className="h-2.5 w-2.5 shrink-0" />
            {secondaryInfo}
          </span>
        )}
      </div>

      {/* Add button */}
      <Button
        size="sm"
        onClick={onAdd}
        className="h-6 px-2.5 text-[11px] font-bold gap-1 bg-accent hover:bg-accent/90 text-white shrink-0"
      >
        <Plus className="h-3 w-3" />
        Add
      </Button>
    </div>
  );
}
