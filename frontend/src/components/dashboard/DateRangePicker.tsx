import { useState } from 'react';
import { format } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type DashboardRange = {
  from: Date;
  to: Date;
  label: string;
};

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const presets: { key: string; label: string; build: () => DashboardRange }[] = [
  {
    key: 'today',
    label: 'Today',
    build: () => {
      const today = new Date();
      return { from: startOfDay(today), to: endOfDay(today), label: 'Today' };
    },
  },
  {
    key: 'last7',
    label: 'Last 7 Days',
    build: () => {
      const to = endOfDay(new Date());
      const from = startOfDay(new Date());
      from.setDate(from.getDate() - 6);
      return { from, to, label: 'Last 7 Days' };
    },
  },
  {
    key: 'last30',
    label: 'Last 30 Days',
    build: () => {
      const to = endOfDay(new Date());
      const from = startOfDay(new Date());
      from.setDate(from.getDate() - 29);
      return { from, to, label: 'Last 30 Days' };
    },
  },
  {
    key: 'week',
    label: 'This Week',
    build: () => {
      const now = new Date();
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const from = startOfDay(new Date(now));
      from.setDate(now.getDate() - diff);
      return { from, to: endOfDay(now), label: 'This Week' };
    },
  },
  {
    key: 'month',
    label: 'This Month',
    build: () => {
      const now = new Date();
      const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
      return { from, to: endOfDay(now), label: 'This Month' };
    },
  },
  {
    key: 'lastMonth',
    label: 'Last Month',
    build: () => {
      const now = new Date();
      const from = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const to = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      return { from, to, label: 'Last Month' };
    },
  },
  {
    key: 'quarter',
    label: 'This Quarter',
    build: () => {
      const now = new Date();
      const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const from = startOfDay(new Date(now.getFullYear(), qStartMonth, 1));
      return { from, to: endOfDay(now), label: 'This Quarter' };
    },
  },
  {
    key: 'year',
    label: 'This Year',
    build: () => {
      const now = new Date();
      const from = startOfDay(new Date(now.getFullYear(), 0, 1));
      return { from, to: endOfDay(now), label: 'This Year' };
    },
  },
  {
    key: 'allTime',
    label: 'All Time',
    build: () => {
      const from = startOfDay(new Date('2000-01-01'));
      return { from, to: endOfDay(new Date()), label: 'All Time' };
    },
  },
];

export const defaultDashboardRange = (): DashboardRange =>
  presets.find((p) => p.key === 'last7')!.build();

export const formatRangeLabel = (range: DashboardRange): string => {
  if (range.label && range.label !== 'Custom') return range.label;
  const from = format(range.from, 'MMM d');
  const to = format(range.to, 'MMM d, yyyy');
  return `${from} – ${to}`;
};

interface Props {
  value: DashboardRange;
  onChange: (range: DashboardRange) => void;
}

export function DateRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pickerRange, setPickerRange] = useState<DateRange | undefined>({
    from: value.from,
    to: value.to,
  });

  const applyPreset = (preset: typeof presets[number]) => {
    const range = preset.build();
    onChange(range);
    setPickerRange({ from: range.from, to: range.to });
    setOpen(false);
  };

  const applyCustom = () => {
    if (pickerRange?.from && pickerRange?.to) {
      onChange({
        from: startOfDay(pickerRange.from),
        to: endOfDay(pickerRange.to),
        label: 'Custom',
      });
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <CalendarIcon className="h-4 w-4" />
          {formatRangeLabel(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 flex" align="start">
        <div className="flex flex-col p-2 border-r border-border min-w-[140px]">
          {presets.map((preset) => (
            <button
              key={preset.key}
              onClick={() => applyPreset(preset)}
              className={cn(
                'text-left px-3 py-1.5 text-sm rounded-md hover:bg-muted transition-colors',
                value.label === preset.label && 'bg-muted font-medium'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col">
          <Calendar
            mode="range"
            selected={pickerRange}
            onSelect={setPickerRange}
            numberOfMonths={2}
            defaultMonth={value.from}
          />
          <div className="flex items-center justify-end gap-2 p-3 border-t border-border">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={applyCustom}
              disabled={!pickerRange?.from || !pickerRange?.to}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
