import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Clock } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface SnoozeOption {
  key: string;
  label: string;
  /** Returns the wake-up timestamp (or null for "custom — let user pick"). */
  compute: (now: Date) => Date | null;
}

// All "next *" buckets resolve to a fixed hour the next day(s). Anchor
// the hour-of-day so snoozing at 11 PM still wakes you up at 8 AM, not
// 11 PM the next day.
const OPTIONS: SnoozeOption[] = [
  {
    key: 'later_today',
    label: 'Later today',
    compute: (now) => {
      const t = new Date(now);
      t.setHours(now.getHours() + 3, 0, 0, 0);
      // If "+3h" lands past 8 PM, push to tomorrow 8 AM instead.
      if (t.getHours() >= 20 || t.getDate() !== now.getDate()) {
        const m = new Date(now);
        m.setDate(now.getDate() + 1);
        m.setHours(8, 0, 0, 0);
        return m;
      }
      return t;
    },
  },
  {
    key: 'tomorrow',
    label: 'Tomorrow morning',
    compute: (now) => {
      const t = new Date(now);
      t.setDate(now.getDate() + 1);
      t.setHours(8, 0, 0, 0);
      return t;
    },
  },
  {
    key: 'weekend',
    label: 'This weekend',
    compute: (now) => {
      // Saturday 8 AM. If we're already past Saturday morning, push to next Sat.
      const t = new Date(now);
      const dow = t.getDay(); // 0 Sun, 6 Sat
      const delta = (6 - dow + 7) % 7 || 7;
      t.setDate(t.getDate() + delta);
      t.setHours(8, 0, 0, 0);
      return t;
    },
  },
  {
    key: 'next_week',
    label: 'Next Monday',
    compute: (now) => {
      const t = new Date(now);
      const dow = t.getDay();
      const delta = ((1 - dow + 7) % 7) || 7;
      t.setDate(t.getDate() + delta);
      t.setHours(8, 0, 0, 0);
      return t;
    },
  },
];

interface SnoozeMenuProps {
  trigger: React.ReactNode;
  currentSnoozedUntil?: string | null;
  onSnooze: (wakeAt: Date) => void | Promise<void>;
  onUnsnooze?: () => void | Promise<void>;
  align?: 'start' | 'end' | 'center';
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function SnoozeMenu({
  trigger,
  currentSnoozedUntil,
  onSnooze,
  onUnsnooze,
  align = 'end',
  side = 'bottom',
}: SnoozeMenuProps) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const now = new Date();
  const isSnoozed = !!currentSnoozedUntil && new Date(currentSnoozedUntil).getTime() > now.getTime();

  const handlePick = async (wakeAt: Date) => {
    setOpen(false);
    await onSnooze(wakeAt);
  };

  const handleCustom = async () => {
    if (!customValue) return;
    const wakeAt = new Date(customValue);
    if (Number.isNaN(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) return;
    setOpen(false);
    await onSnooze(wakeAt);
  };

  const handleUnsnooze = async () => {
    setOpen(false);
    await onUnsnooze?.();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={side} align={align} className="w-64 p-2">
        {isSnoozed && (
          <div className="px-2 py-2 mb-2 text-xs rounded bg-accent/10 text-foreground">
            <div className="font-medium">Snoozed until</div>
            <div className="text-muted-foreground">
              {format(new Date(currentSnoozedUntil!), "EEE, MMM d 'at' h:mm a")}
            </div>
            {onUnsnooze && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleUnsnooze}
                className="mt-1 h-6 text-xs px-2 w-full justify-start hover:bg-muted"
              >
                Unsnooze now
              </Button>
            )}
          </div>
        )}

        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 px-2 mb-1">
          Snooze until
        </div>
        <div className="space-y-0.5">
          {OPTIONS.map((opt) => {
            const wakeAt = opt.compute(now);
            if (!wakeAt) return null;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => handlePick(wakeAt)}
                className={cn(
                  'w-full px-2 py-1.5 rounded text-left text-xs hover:bg-muted/60 flex items-center justify-between gap-2',
                )}
              >
                <span className="font-medium text-foreground">{opt.label}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {format(wakeAt, "MMM d, h:mm a")}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-border/60 mt-2 pt-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 px-2 block mb-1">
            Pick a time
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
              <Clock className="h-3 w-3 mr-1" /> Set
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
