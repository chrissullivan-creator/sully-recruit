import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatThreadTimestamp, formatAbsoluteTimestamp } from '@/lib/format-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface EmailCardMessage {
  id: string;
  direction: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address: string | null;
  attachments?: unknown;
}

interface EmailMessageCardProps {
  message: EmailCardMessage;
  defaultExpanded: boolean;
  entityName?: string | null;
  attachmentsSlot?: React.ReactNode;
  stripQuoted: (body: string) => string;
}

/**
 * Outlook-style collapsible email card. One per message in the thread.
 * Latest message expanded by default; older messages collapse to a single
 * header row showing sender / preview / date.
 */
export function EmailMessageCard({
  message,
  defaultExpanded,
  entityName,
  attachmentsSlot,
  stripQuoted,
}: EmailMessageCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isOutbound = message.direction === 'outbound';

  const ts = message.sent_at || message.received_at || message.created_at;
  const senderLabel = isOutbound
    ? message.sender_name || 'You'
    : message.sender_name || entityName || 'Sender';
  const senderEmail = message.sender_address || '';
  const recipientLabel = message.recipient_address || '';

  const rawBody = message.body || '';
  const cleanBody = rawBody ? stripQuoted(rawBody) : '';
  const previewSnippet = cleanBody
    ? cleanBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
    : '(no content)';

  return (
    <div
      className={cn(
        'rounded-lg border bg-background transition-shadow',
        expanded ? 'border-border shadow-sm' : 'border-border/60 hover:border-border',
      )}
    >
      {/* Header row — always visible. Click toggles expanded state. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3"
      >
        <div className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground truncate">{senderLabel}</span>
              {senderEmail && (
                <span className="text-xs text-muted-foreground truncate">&lt;{senderEmail}&gt;</span>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0 cursor-default">
                  {formatThreadTimestamp(ts)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {formatAbsoluteTimestamp(ts)}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* When collapsed: show a To-line preview snippet. When expanded:
              show full To / Subject metadata. */}
          {!expanded ? (
            <p className="text-xs text-muted-foreground truncate mt-0.5">{previewSnippet}</p>
          ) : (
            <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {recipientLabel && (
                <div>
                  <span className="font-medium text-foreground/70">To:</span>{' '}
                  <span className="truncate">{recipientLabel}</span>
                </div>
              )}
              {message.subject && (
                <div>
                  <span className="font-medium text-foreground/70">Subject:</span>{' '}
                  <span className="truncate">{message.subject}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Body — only when expanded */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-border/60">
          {cleanBody ? (
            <div
              className="prose prose-sm max-w-none text-foreground [&_a]:text-accent [&_a]:underline"
              dangerouslySetInnerHTML={{ __html: cleanBody }}
            />
          ) : (
            <p className="text-sm italic text-muted-foreground">(No content)</p>
          )}
          {attachmentsSlot}
        </div>
      )}
    </div>
  );
}
