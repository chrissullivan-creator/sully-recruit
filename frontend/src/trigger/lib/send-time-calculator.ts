/**
 * Send time calculation for sequence v2 scheduler.
 *
 * KEY CONCEPT: Delay hours tick ONLY during the send window ("business hours").
 * Hours outside the window don't count toward the delay.
 *
 * Example (window 6AM–9PM EST, 15 active hours/day):
 *   Enrolled 5 PM, 10h email delay:
 *     4h today (5PM→9PM) + 6h next day (6AM→noon) = fires at noon next day
 *
 *   Enrolled 11:15 PM, SMS 5h 35m delay:
 *     Outside window → next open 6 AM + 5h35m = 11:35 AM
 *
 * LinkedIn connections ignore the window entirely — fire immediately 24/7.
 */
import { logger } from "@trigger.dev/sdk/v3";

// ─────────────────────────────────────────────────────────────────────────────
// EST helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get EST date components from a Date. */
function toEST(date: Date): { year: number; month: number; day: number; hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hours: get("hour"), minutes: get("minute") };
}

/** Parse "HH:MM" → minutes since midnight. */
function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Create a Date for a specific EST time on a specific EST date.
 * Uses the offset trick: build a UTC date, then adjust by the EST offset for that moment.
 */
function estToUTC(year: number, month: number, day: number, hours: number, minutes: number): Date {
  // Start with a rough UTC guess
  const guess = new Date(Date.UTC(year, month, day, hours + 5, minutes)); // EST ≈ UTC-5
  // Check actual EST offset for this moment
  const actualEST = toEST(guess);
  const diffH = hours - actualEST.hours;
  const diffM = minutes - actualEST.minutes;
  return new Date(guess.getTime() + diffH * 3600000 + diffM * 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: addWindowHours — counts delay only during send window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add delay minutes counting only time within the send window.
 * Skips overnight hours. Returns the UTC timestamp when the delay expires.
 *
 * @param startTime  The reference time (enrollment or connection accepted)
 * @param delayMinutes  Total delay in minutes (hours * 60 + minutes)
 * @param windowStartStr  "HH:MM" EST when the window opens
 * @param windowEndStr    "HH:MM" EST when the window closes
 */
function addWindowMinutes(
  startTime: Date,
  delayMinutes: number,
  windowStartStr: string,
  windowEndStr: string,
): Date {
  const winStartMin = parseTimeToMinutes(windowStartStr);
  const winEndMin = parseTimeToMinutes(windowEndStr);
  const windowDuration = winEndMin - winStartMin; // minutes of active window per day

  if (windowDuration <= 0) {
    // Bad config — just add calendar minutes
    return new Date(startTime.getTime() + delayMinutes * 60000);
  }

  let remaining = delayMinutes;
  let est = toEST(startTime);
  let currentMin = est.hours * 60 + est.minutes;

  // If zero delay, just clamp to window
  if (remaining <= 0) {
    if (currentMin >= winStartMin && currentMin < winEndMin) {
      return startTime; // already inside window
    }
    if (currentMin < winStartMin) {
      return estToUTC(est.year, est.month, est.day, Math.floor(winStartMin / 60), winStartMin % 60);
    }
    // Past window close — next day
    const nextDay = new Date(startTime.getTime() + 86400000);
    const nextEST = toEST(nextDay);
    return estToUTC(nextEST.year, nextEST.month, nextEST.day, Math.floor(winStartMin / 60), winStartMin % 60);
  }

  // If outside window, jump to next window open
  if (currentMin < winStartMin) {
    // Before window today — jump to window start
    est = { ...est, hours: Math.floor(winStartMin / 60), minutes: winStartMin % 60 };
    currentMin = winStartMin;
  } else if (currentMin >= winEndMin) {
    // After window close — jump to next day's window start
    const nextDay = new Date(startTime.getTime() + 86400000);
    est = toEST(nextDay);
    est.hours = Math.floor(winStartMin / 60);
    est.minutes = winStartMin % 60;
    currentMin = winStartMin;
  }

  // Count delay within windows, day by day
  for (let safety = 0; safety < 60; safety++) {
    // How many minutes left in today's window?
    const availableToday = winEndMin - currentMin;

    if (availableToday >= remaining) {
      // Delay finishes today
      const finalMin = currentMin + remaining;
      return estToUTC(est.year, est.month, est.day, Math.floor(finalMin / 60), finalMin % 60);
    }

    // Use up today's remaining window time, roll to next day
    remaining -= availableToday;
    const tomorrow = estToUTC(est.year, est.month, est.day + 1, Math.floor(winStartMin / 60), winStartMin % 60);
    est = toEST(tomorrow);
    currentMin = winStartMin;
  }

  // Fallback — should never reach here
  logger.warn("addWindowMinutes exceeded 60-day loop", { delayMinutes });
  return new Date(startTime.getTime() + delayMinutes * 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily/hourly cap checking (unchanged from before)
// ─────────────────────────────────────────────────────────────────────────────

interface CapCheckResult {
  allowed: boolean;
}

export async function checkDailyCap(
  supabase: any,
  accountId: string,
  channel: string,
  estDate: string,
): Promise<CapCheckResult> {
  const { data: limit } = await supabase
    .from("channel_limits")
    .select("daily_max")
    .eq("channel", channel)
    .maybeSingle();

  if (!limit?.daily_max) return { allowed: true };

  const { data: log } = await supabase
    .from("daily_send_log")
    .select("count")
    .eq("account_id", accountId)
    .eq("channel", channel)
    .eq("send_date", estDate)
    .maybeSingle();

  return { allowed: (log?.count || 0) < limit.daily_max };
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

// ─────────────────────────────────────────────────────────────────────────────
// Main: calculateSendTime (business-hours model)
// ─────────────────────────────────────────────────────────────────────────────

interface SendTimeInput {
  startTime: Date;             // enrollment time (or connection accepted time)
  delayHours: number;          // hours of delay (counted within window)
  delayMinutes: number;        // additional minutes
  jiggleMinutes: number;       // random ± offset
  channel: string;
  sendWindowStart: string;     // "HH:MM" EST
  sendWindowEnd: string;       // "HH:MM" EST
  accountId: string;
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
  // LinkedIn connections bypass everything — fire now
  if (input.channel === "linkedin_connection") {
    const result = new Date(input.startTime);
    // Add small random offset (0-3 min) to avoid burst
    result.setMinutes(result.getMinutes() + Math.floor(Math.random() * 4));
    return result;
  }

  const totalDelayMinutes = input.delayHours * 60 + input.delayMinutes;

  // Count delay within window hours
  let result = addWindowMinutes(
    input.startTime,
    totalDelayMinutes,
    input.sendWindowStart,
    input.sendWindowEnd,
  );

  // Apply jiggle
  if (input.jiggleMinutes > 0) {
    const jiggle = Math.floor(Math.random() * input.jiggleMinutes * 2) - input.jiggleMinutes;
    result = new Date(result.getTime() + jiggle * 60000);

    // Re-clamp if jiggle pushed outside window
    const est = toEST(result);
    const currentMin = est.hours * 60 + est.minutes;
    const winStart = parseTimeToMinutes(input.sendWindowStart);
    const winEnd = parseTimeToMinutes(input.sendWindowEnd);
    if (currentMin < winStart || currentMin >= winEnd) {
      result = addWindowMinutes(result, 0, input.sendWindowStart, input.sendWindowEnd);
    }
  }

  // Check daily cap — roll forward if needed
  for (let attempts = 0; attempts < 14; attempts++) {
    const est = toEST(result);
    const estDate = `${est.year}-${String(est.month + 1).padStart(2, "0")}-${String(est.day).padStart(2, "0")}`;
    const dailyCheck = await checkDailyCap(supabase, input.accountId, input.channel, estDate);
    if (dailyCheck.allowed) break;
    // Roll to next day window start
    result = addWindowMinutes(result, parseTimeToMinutes(input.sendWindowEnd) - parseTimeToMinutes(input.sendWindowStart) + 1, input.sendWindowStart, input.sendWindowEnd);
    logger.info("Daily cap hit, rolling to next day", { channel: input.channel });
  }

  // Check hourly cap — move to next hour
  for (let attempts = 0; attempts < 24; attempts++) {
    const hourlyCheck = await checkHourlyCap(supabase, input.accountId, input.channel, result);
    if (hourlyCheck.allowed) break;
    result = new Date(result.getTime() + 3600000);
    result.setMinutes(0, 0, 0);
    // Re-clamp to window
    result = addWindowMinutes(result, 0, input.sendWindowStart, input.sendWindowEnd);
  }

  // Randomize exact minute within the assigned hour (avoid all sends at :00)
  const finalEst = toEST(result);
  const winEnd = parseTimeToMinutes(input.sendWindowEnd);
  const currentMin = finalEst.hours * 60 + finalEst.minutes;
  const remainingInHour = Math.min(60 - (currentMin % 60), winEnd - currentMin);
  if (remainingInHour > 1) {
    result.setSeconds(Math.floor(Math.random() * 60));
  }

  return result;
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
): Promise<Date> {
  // 4h hardcoded minimum + additional delay, all in window hours
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
  });
}
