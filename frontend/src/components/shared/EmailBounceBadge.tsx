import { MailX } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface Props {
  emailInvalid: boolean | null | undefined;
  reason?: string | null;
  invalidatedAt?: string | null;
  /** "badge" = pill text; "icon" = compact icon-only for table cells. */
  variant?: 'badge' | 'icon';
  className?: string;
}

export function EmailBounceBadge({ emailInvalid, reason, invalidatedAt, variant = 'badge', className }: Props) {
  if (!emailInvalid) return null;

  const tooltip = (
    <div className="text-xs space-y-0.5">
      <div className="font-semibold">Email bounced</div>
      {reason && <div className="text-muted-foreground">{reason}</div>}
      {invalidatedAt && (
        <div className="text-muted-foreground/80">{format(new Date(invalidatedAt), 'MMM d, yyyy')}</div>
      )}
    </div>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {variant === 'icon' ? (
            <span className={cn('inline-flex items-center text-red-500', className)}>
              <MailX className="h-3.5 w-3.5" />
            </span>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full bg-red-500/10 text-red-600 border border-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                className,
              )}
            >
              <MailX className="h-3 w-3" />
              Bounced
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
