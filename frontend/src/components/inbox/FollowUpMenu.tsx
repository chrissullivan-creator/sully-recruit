import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Bell } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface FollowUpOption {
  key: string;
  label: string;
  days: number;
}

const OPTIONS: FollowUpOption[] = [
  { key: '3d', label: '3 days from now', days: 3 },
  { key: '1w', label: 'In 1 week', days: 7 },
  { key: '2w', label: 'In 2 weeks', days: 14 },
  { key: '1m', label: 'In 1 month', days: 30 },
];

interface FollowUpMenuProps {
  trigger: React.ReactNode;
  currentFollowUp?: string | null;
  onSet: (followUpAt: Date) => void | Promise<void>;
  onClear?: () => void | Promise<void>;
  align?: 'start' | 'end' | 'center';
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Popover for setting a "remind me if no reply by X" reminder on a
 * conversation. The Inngest cron `inbox-process-follow-ups` runs hourly
 * and surfaces the thread (marks it unread) only if no reply has come in
 * since the reminder was set. If a reply did come in, the reminder is
 * cancelled silently.
 */
export function FollowUpMenu({
  trigger,
  currentFollowUp,
  onSet,
  onClear,
  align = 'end',
  side = 'bottom',
}: FollowUpMenuProps) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const isSet = !!currentFollowUp && new Date(currentFollowUp).getTime() > Date.now();
  const now = new Date();

  const handlePick = async (days: number) => {
    const ts = new Date(now);
    ts.setDate(ts.getDate() + days);
    ts.setHours(8, 0, 0, 0); // anchor at 8 AM local
    setOpen(false);
    await onSet(ts);
  };

  const handleCustom = async () => {
    if (!customValue) return;
    const ts = new Date(customValue);
    if (Number.isNaN(ts.getTime()) || ts.getTime() <= Date.now()) return;
    setOpen(false);
    await onSet(ts);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={side} align={align} className="w-72 p-2">
        {isSet && (
          <div className="px-2 py-2 mb-2 text-xs rounded bg-accent/10 text-foreground">
            <div className="font-medium">Reminder set</div>
            <div className="text-muted-foreground">
              If no reply by {format(new Date(currentFollowUp!), "EEE, MMM d 'at' h:mm a")}, this thread will resurface.
            </div>
            {onClear && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => { setOpen(false); await onClear(); }}
                className="mt-1 h-6 text-xs px-2 w-full justify-start hover:bg-muted"
              >
                Clear reminder
              </Button>
            )}
          </div>
        )}

        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 px-2 mb-1">
          Remind me if no reply
        </div>
        <div className="space-y-0.5">
          {OPTIONS.map((opt) => {
            const ts = new Date(now);
            ts.setDate(ts.getDate() + opt.days);
            ts.setHours(8, 0, 0, 0);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => handlePick(opt.days)}
                className={cn(
                  'w-full px-2 py-1.5 rounded text-left text-xs hover:bg-muted/60 flex items-center justify-between gap-2',
                )}
              >
                <span className="font-medium text-foreground">{opt.label}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {format(ts, "MMM d")}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-border/60 mt-2 pt-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 px-2 block mb-1">
            Custom date / time
          </label>
          <div className="flex gap-1 px-1">
            <input
              type="datetime-local"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              className="flex-1 text-xs px-2 py-1 rounded border border-border bg-background"
              min={format(now, "yyyy-MM-dd'T'HH:mm")}
            />
            <Button size="sm" onClick={handleCustom} disabled={!customValue} className="text-xs h-7 px-2">
              <Bell className="h-3 w-3 mr-1" /> Set
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
