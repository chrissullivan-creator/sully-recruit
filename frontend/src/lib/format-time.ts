import {
  differenceInMinutes,
  differenceInDays,
  isSameDay,
  isYesterday,
  isSameYear,
  format,
} from 'date-fns';

/**
 * Smart short-form timestamp for inbox lists.
 *
 *   < 1 min      → "Just now"
 *   same day     → "10:43 AM"
 *   yesterday    → "Yesterday"
 *   this week    → "Mon"
 *   same year    → "May 12"
 *   older        → "May 12, 2025"
 */
export function formatSmartTimestamp(input: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (!input) return '';
  const ts = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (Number.isNaN(ts.getTime())) return '';

  if (differenceInMinutes(now, ts) < 1) return 'Just now';
  if (isSameDay(now, ts)) return format(ts, 'h:mm a');
  if (isYesterday(ts)) return 'Yesterday';
  if (differenceInDays(now, ts) < 7) return format(ts, 'EEE');
  if (isSameYear(now, ts)) return format(ts, 'MMM d');
  return format(ts, 'MMM d, yyyy');
}

/**
 * Full absolute timestamp for tooltip / hover detail.
 * "Tuesday, May 14, 2026 at 10:43 AM"
 */
export function formatAbsoluteTimestamp(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const ts = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (Number.isNaN(ts.getTime())) return '';
  return format(ts, "EEEE, MMMM d, yyyy 'at' h:mm a");
}

/**
 * In-thread per-message timestamp. Includes the time on every line, with
 * a friendlier date prefix for older messages.
 *   today         → "10:43 AM"
 *   yesterday     → "Yesterday 10:43 AM"
 *   this week     → "Mon 10:43 AM"
 *   same year     → "May 12, 10:43 AM"
 *   older         → "May 12, 2025, 10:43 AM"
 */
export function formatThreadTimestamp(input: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (!input) return '';
  const ts = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (Number.isNaN(ts.getTime())) return '';

  if (isSameDay(now, ts)) return format(ts, 'h:mm a');
  if (isYesterday(ts)) return `Yesterday ${format(ts, 'h:mm a')}`;
  if (differenceInDays(now, ts) < 7) return format(ts, 'EEE h:mm a');
  if (isSameYear(now, ts)) return format(ts, 'MMM d, h:mm a');
  return format(ts, 'MMM d, yyyy, h:mm a');
}

export type DateGroup = 'today' | 'yesterday' | 'this_week' | 'earlier_this_month' | 'this_year' | 'older';

export interface DateGroupInfo {
  key: DateGroup;
  label: string;
}

/** Bucket a timestamp into one of the six list date-group buckets. */
export function getDateGroup(input: string | number | Date | null | undefined, now: Date = new Date()): DateGroupInfo {
  if (!input) return { key: 'older', label: 'Older' };
  const ts = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (Number.isNaN(ts.getTime())) return { key: 'older', label: 'Older' };

  if (isSameDay(now, ts)) return { key: 'today', label: 'Today' };
  if (isYesterday(ts)) return { key: 'yesterday', label: 'Yesterday' };

  const days = differenceInDays(now, ts);
  if (days < 7) return { key: 'this_week', label: 'This week' };

  if (now.getFullYear() === ts.getFullYear() && now.getMonth() === ts.getMonth()) {
    return { key: 'earlier_this_month', label: 'Earlier this month' };
  }
  if (isSameYear(now, ts)) {
    return { key: 'this_year', label: format(ts, 'MMMM') };
  }
  return { key: 'older', label: format(ts, 'yyyy') };
}
