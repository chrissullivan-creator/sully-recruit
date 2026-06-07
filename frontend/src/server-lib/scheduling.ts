/**
 * Self-scheduling slot math, shared by api/schedule/slots.ts (compute open
 * slots) and api/schedule/book.ts (re-validate a requested slot).
 *
 * All slot computation is done in the link's IANA timezone using native
 * Intl APIs — no date-fns-tz dependency. Working-hours windows are expressed
 * in local "HH:MM"; the helpers below convert local wall-clock times to UTC
 * instants (and back) so free/busy subtraction happens in a single absolute
 * timeline.
 */

import type { BusyInterval } from "./microsoft-graph.js";

export interface WorkingWindow {
  start: string; // "HH:MM" local
  end: string; // "HH:MM" local
}
export type WorkingHours = Record<string, WorkingWindow[]>;

export interface SchedulingLinkConfig {
  duration_min: number;
  timezone: string;
  working_hours: WorkingHours;
  buffer_min: number;
  min_notice_hours: number;
  max_days_out: number;
}

export interface Slot {
  start: string; // ISO UTC
  end: string; // ISO UTC
}

export interface DayGroup {
  date: string; // YYYY-MM-DD (in the link's timezone)
  slots: Array<{ start: string; end: string }>; // ISO UTC instants
}

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * The offset (in minutes) of `tz` from UTC at the given instant — positive
 * for zones east of UTC. Uses Intl to read the zone's wall-clock at that
 * instant and diffs against the UTC wall-clock. Handles DST because the
 * offset is computed per-instant.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = parseInt(p.value, 10);
  }
  // The wall-clock the zone shows for this instant, interpreted as if it
  // were UTC, minus the real UTC instant = the offset.
  const asUtc = Date.UTC(
    map.year,
    (map.month || 1) - 1,
    map.day,
    map.hour === 24 ? 0 : map.hour,
    map.minute,
    map.second,
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Convert a local wall-clock (year/month/day in tz + minutes-since-midnight)
 * to the corresponding UTC instant. Resolves the offset iteratively so DST
 * transition days land on the correct instant.
 */
function localWallClockToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  minutesIntoDay: number,
  tz: string,
): Date {
  const hour = Math.floor(minutesIntoDay / 60);
  const minute = minutesIntoDay % 60;
  // First guess: treat the wall-clock as UTC, then correct by the offset at
  // that guessed instant, then re-correct once (covers DST edges).
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMinutes(new Date(guess), tz);
    const corrected = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/** YYYY-MM-DD + weekday for an instant, in the given timezone. */
function localDateParts(date: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayShort = map.weekday || "Sun";
  const weekdayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayShort);
  return {
    y: parseInt(map.year, 10),
    m: parseInt(map.month, 10),
    d: parseInt(map.day, 10),
    weekday: weekdayIdx < 0 ? 0 : weekdayIdx,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Does [aStart,aEnd) overlap [bStart,bEnd)? (half-open, in ms) */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compute open booking slots across [from, to] for a link, subtracting the
 * owner's busy intervals AND already-booked slots. Returns slots grouped by
 * local calendar day, each as a UTC ISO start/end.
 *
 * - `from` / `to` are UTC instants bounding the requested window. They are
 *   additionally clamped to [now + min_notice, now + max_days_out].
 * - A slot is offered only if the whole slot (optionally padded by
 *   buffer_min on each side) is free of busy blocks and existing bookings.
 */
export function computeOpenSlots(
  link: SchedulingLinkConfig,
  fromUtc: Date,
  toUtc: Date,
  busy: BusyInterval[],
  bookings: Array<{ start_at: string; end_at: string }>,
  now: Date = new Date(),
): DayGroup[] {
  const tz = link.timezone || "America/New_York";
  const duration = Math.max(5, link.duration_min || 30);
  const buffer = Math.max(0, link.buffer_min || 0);

  // Effective window: clamp to notice + horizon.
  const earliest = new Date(now.getTime() + (link.min_notice_hours || 0) * 3600_000);
  const horizon = new Date(now.getTime() + (link.max_days_out || 21) * 86_400_000);
  const windowStart = new Date(Math.max(fromUtc.getTime(), earliest.getTime()));
  const windowEnd = new Date(Math.min(toUtc.getTime(), horizon.getTime()));
  if (windowStart >= windowEnd) return [];

  // Pre-parse busy + bookings into ms ranges (padded by buffer).
  const blocked: Array<[number, number]> = [];
  for (const b of busy) {
    const s = new Date(b.start).getTime();
    const e = new Date(b.end).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      blocked.push([s - buffer * 60000, e + buffer * 60000]);
    }
  }
  for (const bk of bookings) {
    const s = new Date(bk.start_at).getTime();
    const e = new Date(bk.end_at).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      blocked.push([s - buffer * 60000, e + buffer * 60000]);
    }
  }

  const isBlocked = (slotStart: number, slotEnd: number): boolean =>
    blocked.some(([bs, be]) => overlaps(slotStart, slotEnd, bs, be));

  const groups: DayGroup[] = [];

  // Walk day-by-day in the link's timezone. Start from the local date of
  // windowStart, advance one calendar day at a time until past windowEnd.
  let cursorDay = localDateParts(windowStart, tz);
  // Cap the loop defensively at max_days_out + 2 days.
  const maxIterations = (link.max_days_out || 21) + 2;

  for (let iter = 0; iter < maxIterations; iter++) {
    // Build a probe instant at local noon for this calendar day so we read
    // the right weekday and don't slip across a date boundary via DST.
    const noonProbe = localWallClockToUtc(cursorDay.y, cursorDay.m, cursorDay.d, 12 * 60, tz);
    if (noonProbe.getTime() - 12 * 3600_000 > windowEnd.getTime()) break;

    const dayKey = DAY_KEYS[cursorDay.weekday];
    const windows = link.working_hours?.[dayKey] || [];
    const dateStr = `${cursorDay.y}-${pad2(cursorDay.m)}-${pad2(cursorDay.d)}`;
    const daySlots: Array<{ start: string; end: string }> = [];

    for (const w of windows) {
      const winStart = parseHHMM(w.start);
      const winEnd = parseHHMM(w.end);
      if (winStart === null || winEnd === null || winEnd <= winStart) continue;

      // Step through the window in `duration`-minute increments.
      for (let m = winStart; m + duration <= winEnd; m += duration) {
        const slotStartUtc = localWallClockToUtc(cursorDay.y, cursorDay.m, cursorDay.d, m, tz);
        const slotEndUtc = new Date(slotStartUtc.getTime() + duration * 60000);

        // Within the clamped window?
        if (slotStartUtc < windowStart || slotEndUtc > windowEnd) continue;
        // Not in the past / inside notice horizon (windowStart already covers
        // earliest, but a window can start before windowStart on day 0).
        if (slotStartUtc.getTime() < earliest.getTime()) continue;
        if (isBlocked(slotStartUtc.getTime(), slotEndUtc.getTime())) continue;

        daySlots.push({
          start: slotStartUtc.toISOString(),
          end: slotEndUtc.toISOString(),
        });
      }
    }

    if (daySlots.length > 0) {
      groups.push({ date: dateStr, slots: daySlots });
    }

    // Advance to the next calendar day (local). Use the noon probe + 24h,
    // then re-read the local date so DST shifts don't skip/repeat a day.
    const nextProbe = new Date(noonProbe.getTime() + 24 * 3600_000);
    cursorDay = localDateParts(nextProbe, tz);
  }

  return groups;
}

/**
 * Re-validate that a single requested slot [startUtc, startUtc+duration) is
 * still bookable: inside a working-hours window, past the notice horizon,
 * within max_days_out, and free of busy blocks + existing bookings. Returns
 * the computed end instant when valid, or a reason string when not.
 */
export function validateSlot(
  link: SchedulingLinkConfig,
  startUtc: Date,
  busy: BusyInterval[],
  bookings: Array<{ start_at: string; end_at: string }>,
  now: Date = new Date(),
): { ok: true; endIso: string } | { ok: false; reason: string } {
  const duration = Math.max(5, link.duration_min || 30);
  const endUtc = new Date(startUtc.getTime() + duration * 60000);

  const earliest = new Date(now.getTime() + (link.min_notice_hours || 0) * 3600_000);
  const horizon = new Date(now.getTime() + (link.max_days_out || 21) * 86_400_000);
  if (startUtc.getTime() < earliest.getTime()) {
    return { ok: false, reason: "Too soon — outside the minimum notice window." };
  }
  if (endUtc.getTime() > horizon.getTime()) {
    return { ok: false, reason: "Too far out — beyond the booking horizon." };
  }

  // Must align to a working-hours window on its local day. Reuse
  // computeOpenSlots over a tight window around the requested start, then
  // check the exact instant appears.
  const groups = computeOpenSlots(
    link,
    new Date(startUtc.getTime() - 60000),
    new Date(endUtc.getTime() + 60000),
    busy,
    bookings,
    now,
  );
  const startIso = startUtc.toISOString();
  const found = groups.some((g) => g.slots.some((s) => s.start === startIso));
  if (!found) {
    return { ok: false, reason: "That time is no longer available." };
  }
  return { ok: true, endIso: endUtc.toISOString() };
}
