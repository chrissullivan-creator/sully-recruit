import { CalendarClock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { format, isAfter } from 'date-fns';
import { cn } from '@/lib/utils';

interface Props {
  /** people.ooo_until — the contact's stated return date (or computed resume date). */
  oooUntil?: string | null;
  /** "badge" = pill with text; "icon" = compact icon-only for dense rows. */
  variant?: 'badge' | 'icon';
  className?: string;
}

/**
 * Shown when a contact is on an out-of-office auto-reply. The sequence engine
 * keeps the enrollment active and reschedules the next step to the day after
 * `ooo_until`, so this is informational — it disappears once the date passes
 * (or the webhook clears it after a genuine reply).
 */
export function OutOfOfficeBadge({ oooUntil, variant = 'badge', className }: Props) {
  if (!oooUntil) return null;
  const until = new Date(oooUntil);
  if (isNaN(until.getTime()) || !isAfter(until, new Date())) return null;

  const dateLabel = format(until, 'MMM d, yyyy');
  const tooltip = (
    <div className="text-xs space-y-0.5">
      <div className="font-semibold">Out of office</div>
      <div className="text-muted-foreground">Sequence resumes after {dateLabel}</div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {variant === 'icon' ? (
            <span className={cn('inline-flex items-center text-amber-500', className)}>
              <CalendarClock className="h-3.5 w-3.5" />
            </span>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                className,
              )}
            >
              <CalendarClock className="h-3 w-3" />
              OOO until {dateLabel}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
