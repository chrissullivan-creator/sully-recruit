/**
 * Send time calculation for sequence v2 scheduler.
 *
 * KEY CONCEPT: Delay hours tick ONLY during the send window ("business hours").
 * Hours outside the window don't count toward the delay.
 *
 * Example (window 6AM–9PM, 15 active hours/day):
 *   Enrolled 5 PM, 10h email delay:
 *     4h today (5PM→9PM) + 6h next day (6AM→noon) = fires at noon next day
 *
 *   Enrolled 11:15 PM, SMS 5h 35m delay:
 *     Outside window → next open 6 AM + 5h35m = 11:35 AM
 *
 * LinkedIn connections ignore the window entirely — fire immediately 24/7.
 *
 * TIMEZONE: every calculation runs in an IANA timezone that the caller passes
 * (`sequences.timezone`, settable in the builder). It defaults to
 * `America/New_York` so existing sequences behave exactly as before. The zone
 * is resolved through `Intl` so it is DST-correct year-round — there are no
 * hardcoded UTC offsets anywhere in this file.
 */
import { logger } from "./logger.js";

/** Default zone when a sequence doesn't specify one. */
export const DEFAULT_TZ = "America/New_York";

// ─────────────────────────────────────────────────────────────────────────────
// Timezone helpers (DST-correct via Intl)
// ─────────────────────────────────────────────────────────────────────────────

/** Get wall-clock date components for `date` in `tz`. */
function toZoned(
  date: Date,
  tz: string,
): { year: number; month: number; day: number; hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  // hour can come back as "24" at midnight in some runtimes — normalise.
  const hours = get("hour") % 24;
  return { year: get("year"), month: get("month") - 1, day: get("day"), hours, minutes: get("minute") };
}

/** Parse "HH:MM" → minutes since midnight. */
function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Create the UTC instant for a specific wall-clock time on a specific date in
 * `tz`. DST-correct: we make a UTC guess, read it back in the zone, and correct
 * for the residual offset (handles the ±1h DST shift automatically).
 */
function zonedToUTC(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  tz: string,
): Date {
  const guess = new Date(Date.UTC(year, month, day, hours, minutes));
  const back = toZoned(guess, tz);
  const guessAsLocalMin =
    Date.UTC(back.year, back.month, back.day, back.hours, back.minutes);
  const wantMin = Date.UTC(year, month, day, hours, minutes);
  return new Date(guess.getTime() + (wantMin - guessAsLocalMin));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: addWindowMinutes — counts delay only during send window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add delay minutes counting only time within the send window.
 * Skips overnight hours. Returns the UTC timestamp when the delay expires.
 */
function addWindowMinutes(
  startTime: Date,
  delayMinutes: number,
  windowStartStr: string,
  windowEndStr: string,
  tz: string,
): Date {
  const winStartMin = parseTimeToMinutes(windowStartStr);
  const winEndMin = parseTimeToMinutes(windowEndStr);
  const windowDuration = winEndMin - winStartMin; // minutes of active window per day

  if (windowDuration <= 0) {
    // Bad config — just add calendar minutes
    return new Date(startTime.getTime() + delayMinutes * 60000);
  }

  let remaining = delayMinutes;
  let z = toZoned(startTime, tz);
  let currentMin = z.hours * 60 + z.minutes;

  // If zero delay, just clamp to window
  if (remaining <= 0) {
    if (currentMin >= winStartMin && currentMin < winEndMin) {
      return startTime; // already inside window
    }
    if (currentMin < winStartMin) {
      return zonedToUTC(z.year, z.month, z.day, Math.floor(winStartMin / 60), winStartMin % 60, tz);
    }
    // Past window close — next day
    const nextDay = new Date(startTime.getTime() + 86400000);
    const nz = toZoned(nextDay, tz);
    return zonedToUTC(nz.year, nz.month, nz.day, Math.floor(winStartMin / 60), winStartMin % 60, tz);
  }

  // If outside window, jump to next window open
  if (currentMin < winStartMin) {
    z = { ...z, hours: Math.floor(winStartMin / 60), minutes: winStartMin % 60 };
    currentMin = winStartMin;
  } else if (currentMin >= winEndMin) {
    const nextDay = new Date(startTime.getTime() + 86400000);
    z = toZoned(nextDay, tz);
    z.hours = Math.floor(winStartMin / 60);
    z.minutes = winStartMin % 60;
    currentMin = winStartMin;
  }

  // Count delay within windows, day by day
  for (let safety = 0; safety < 60; safety++) {
    const availableToday = winEndMin - currentMin;

    if (availableToday >= remaining) {
      const finalMin = currentMin + remaining;
      return zonedToUTC(z.year, z.month, z.day, Math.floor(finalMin / 60), finalMin % 60, tz);
    }

    remaining -= availableToday;
    const tomorrow = zonedToUTC(z.year, z.month, z.day + 1, Math.floor(winStartMin / 60), winStartMin % 60, tz);
    z = toZoned(tomorrow, tz);
    currentMin = winStartMin;
  }

  logger.warn("addWindowMinutes exceeded 60-day loop", { delayMinutes });
  return new Date(startTime.getTime() + delayMinutes * 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily/hourly cap checking
// ─────────────────────────────────────────────────────────────────────────────

interface CapCheckResult {
  allowed: boolean;
}

export async function checkDailyCap(
  supabase: any,
  accountId: string,
  channel: string,
  estDate: string,
  tz: string = DEFAULT_TZ,
): Promise<CapCheckResult> {
  const { data: limit } = await supabase
    .from("channel_limits")
    .select("daily_max")
    .eq("channel", channel)
    .maybeSingle();

  if (!limit?.daily_max) return { allowed: true };

  // Sent count for the day from the daily counter table.
  const { data: log } = await supabase
    .from("daily_send_log")
    .select("count")
    .eq("account_id", accountId)
    .eq("channel", channel)
    .eq("send_date", estDate)
    .maybeSingle();
  const sentCount = log?.count || 0;

  // Already-scheduled step_logs for this account+channel on this local date.
  // Without this, init scheduling 300 step-1s would all see "sentCount = 0"
  // and pile onto the same day. Day boundaries are the local-midnight instants
  // in `tz` (DST-correct), matching incrementDailySend's send_date key.
  const [y, m, d] = estDate.split("-").map(Number);
  const dayStart = zonedToUTC(y, (m || 1) - 1, d || 1, 0, 0, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const { count: scheduledCount } = await supabase
    .from("sequence_step_logs")
    .select("id", { count: "exact", head: true })
    .eq("channel", channel)
    .eq("status", "scheduled")
    .gte("scheduled_at", dayStart.toISOString())
    .lt("scheduled_at", dayEnd.toISOString());

  return { allowed: (sentCount + (scheduledCount || 0)) < limit.daily_max };
}

export async function checkHourlyCap(
  supabase: any,
  accountId: string,
  channel: string,
  scheduledAt: Date,
): Promise<CapCheckResult> {
  const { data: limit } = await supabase
    .from("channel_limits")
    .select("hourly_max")
    .eq("channel", channel)
    .maybeSingle();

  if (!limit?.hourly_max) return { allowed: true };

  const hourStart = new Date(scheduledAt);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart.getTime() + 3600000);

  const { count } = await supabase
    .from("sequence_step_logs")
    .select("id", { count: "exact", head: true })
    .eq("channel", channel)
    .gte("scheduled_at", hourStart.toISOString())
    .lt("scheduled_at", hourEnd.toISOString())
    .in("status", ["scheduled", "sent"]);

  return { allowed: (count || 0) < limit.hourly_max };
}

export async function incrementDailySend(
  supabase: any,
  accountId: string,
  channel: string,
  estDate: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("daily_send_log")
    .select("id, count")
    .eq("account_id", accountId)
    .eq("channel", channel)
    .eq("send_date", estDate)
    .maybeSingle();

  if (existing) {
    await supabase.from("daily_send_log").update({ count: existing.count + 1 }).eq("id", existing.id);
  } else {
    await supabase.from("daily_send_log").insert({ account_id: accountId, channel, send_date: estDate, count: 1 });
  }
}

/** Local (tz) calendar date string "YYYY-MM-DD" for a UTC instant. */
export function localDateString(date: Date, tz: string = DEFAULT_TZ): string {
  const z = toZoned(date, tz);
  return `${z.year}-${String(z.month + 1).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: calculateSendTime (business-hours model)
// ─────────────────────────────────────────────────────────────────────────────

interface SendTimeInput {
  startTime: Date;             // enrollment time (or connection accepted time)
  delayHours: number;          // hours of delay (counted within window)
  delayMinutes: number;        // additional minutes
  jiggleMinutes: number;       // random ± offset
  channel: string;
  sendWindowStart: string;     // "HH:MM"
  sendWindowEnd: string;       // "HH:MM"
  accountId: string;
  /** IANA timezone the window/caps are evaluated in. Defaults to America/New_York. */
  timezone?: string;
  /** When true, Sat/Sun results roll forward to Monday at window open. */
  weekdaysOnly?: boolean;
}

/** Day-of-week in `tz` for a UTC date. 0=Sun, 6=Sat. */
function zonedDayOfWeek(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(date);
  const wd = parts.find((p) => p.type === "weekday")?.value || "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** If weekdaysOnly and the date lands on Sat/Sun (tz), bump to Monday at window open. */
function rollWeekendToMonday(date: Date, sendWindowStart: string, tz: string): Date {
  const dow = zonedDayOfWeek(date, tz);
  if (dow !== 0 && dow !== 6) return date;
  const daysToMonday = dow === 6 ? 2 : 1; // Sat → +2, Sun → +1
  const nextMonday = new Date(date.getTime() + daysToMonday * 86400000);
  const monZ = toZoned(nextMonday, tz);
  const winStart = parseTimeToMinutes(sendWindowStart);
  return zonedToUTC(monZ.year, monZ.month, monZ.day, Math.floor(winStart / 60), winStart % 60, tz);
}

/**
 * Calculate the send time for a sequence action.
 *
 * - linkedin_connection: fires immediately at startTime (24/7, no window)
 * - All other channels: delay ticks only within the send window
 * - Jiggle applied after, re-clamped to window if needed
 * - Daily/hourly caps roll forward
 */
export async function calculateSendTime(supabase: any, input: SendTimeInput): Promise<Date> {
  const tz = input.timezone || DEFAULT_TZ;

  // LinkedIn connections bypass everything — fire now
  if (input.channel === "linkedin_connection") {
    const result = new Date(input.startTime);
    result.setMinutes(result.getMinutes() + Math.floor(Math.random() * 4));
    return result;
  }

  const totalDelayMinutes = input.delayHours * 60 + input.delayMinutes;

  let result = addWindowMinutes(
    input.startTime,
    totalDelayMinutes,
    input.sendWindowStart,
    input.sendWindowEnd,
    tz,
  );

  // Apply jiggle
  if (input.jiggleMinutes > 0) {
    const jiggle = Math.floor(Math.random() * input.jiggleMinutes * 2) - input.jiggleMinutes;
    result = new Date(result.getTime() + jiggle * 60000);

    const z = toZoned(result, tz);
    const currentMin = z.hours * 60 + z.minutes;
    const winStart = parseTimeToMinutes(input.sendWindowStart);
    const winEnd = parseTimeToMinutes(input.sendWindowEnd);
    if (currentMin < winStart || currentMin >= winEnd) {
      result = addWindowMinutes(result, 0, input.sendWindowStart, input.sendWindowEnd, tz);
    }
  }

  // Check daily cap — roll forward if needed
  for (let attempts = 0; attempts < 14; attempts++) {
    const estDate = localDateString(result, tz);
    const dailyCheck = await checkDailyCap(supabase, input.accountId, input.channel, estDate, tz);
    if (dailyCheck.allowed) break;
    result = addWindowMinutes(result, parseTimeToMinutes(input.sendWindowEnd) - parseTimeToMinutes(input.sendWindowStart) + 1, input.sendWindowStart, input.sendWindowEnd, tz);
    logger.info("Daily cap hit, rolling to next day", { channel: input.channel });
  }

  // Check hourly cap — move to next hour
  for (let attempts = 0; attempts < 24; attempts++) {
    const hourlyCheck = await checkHourlyCap(supabase, input.accountId, input.channel, result);
    if (hourlyCheck.allowed) break;
    result = new Date(result.getTime() + 3600000);
    result.setMinutes(0, 0, 0);
    result = addWindowMinutes(result, 0, input.sendWindowStart, input.sendWindowEnd, tz);
  }

  if (input.weekdaysOnly) {
    result = rollWeekendToMonday(result, input.sendWindowStart, tz);
  }

  // Snap to a bursty hot-spot within the assigned hour.
  result = snapToHotSpot(result, input.sendWindowEnd, tz);

  return result;
}

/** Cheap LCG so we get reproducible "random" hot-spots per hour. */
function lcg(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) | 0;
    return (state >>> 0) % 2147483648;
  };
}

/**
 * Snap a scheduled time to one of 6 deterministic hot-spots in its hour, with
 * small ±90s jitter. Ensures bursty clustering across independently-scheduled
 * enrollments while keeping the result inside the send window.
 */
function snapToHotSpot(result: Date, sendWindowEnd: string, tz: string): Date {
  const hourStart = new Date(result.getTime());
  hourStart.setUTCMinutes(0, 0, 0);

  const hourSeed = Math.floor(hourStart.getTime() / 3600000);
  const rand = lcg(hourSeed);
  const hotSpots: number[] = [];
  for (let i = 0; i < 6; i++) {
    hotSpots.push((rand() % 3300) + 60); // 60..3360 sec
  }

  const winEnd = parseTimeToMinutes(sendWindowEnd);
  const finalZ = toZoned(hourStart, tz);
  const hourStartMin = finalZ.hours * 60 + finalZ.minutes;
  const maxOffsetSec = Math.min(3540, Math.max(0, (winEnd - hourStartMin) * 60 - 30));

  const chosenSpot = hotSpots[Math.floor(Math.random() * hotSpots.length)];
  const jitterSec = Math.floor(Math.random() * 200) - 100;
  const offsetSec = Math.max(30, Math.min(maxOffsetSec, chosenSpot + jitterSec));

  return new Date(hourStart.getTime() + offsetSec * 1000);
}

/**
 * Calculate send time for a linkedin_message after connection accepted.
 * Uses the same business-hours model: 4h minimum + additional delay, all counted within window.
 */
export async function calculatePostConnectionSendTime(
  supabase: any,
  connectionAcceptedAt: Date,
  additionalDelayHours: number,
  additionalDelayMinutes: number,
  jiggleMinutes: number,
  sendWindowStart: string,
  sendWindowEnd: string,
  accountId: string,
  timezone: string = DEFAULT_TZ,
): Promise<Date> {
  const totalMinutes = 4 * 60 + additionalDelayHours * 60 + additionalDelayMinutes;

  return calculateSendTime(supabase, {
    startTime: connectionAcceptedAt,
    delayHours: 0,
    delayMinutes: totalMinutes,
    jiggleMinutes,
    channel: "linkedin_message",
    sendWindowStart,
    sendWindowEnd,
    accountId,
    timezone,
  });
}
