/**
 * Send time calculation for sequence v2 scheduler.
 *
 * All times stored and processed in EST (America/New_York).
 * Each enrollment runs on its own independent clock starting at enrolled_at.
 */
import { logger } from "@trigger.dev/sdk/v3";

interface SendTimeInput {
  enrolledAt: string; // ISO timestamp
  baseDelayHours: number;
  delayIntervalMinutes: number;
  jiggleMinutes: number;
  channel: string;
  respectSendWindow: boolean;
  sendWindowStart: string; // "HH:MM" in EST (from sequence)
  sendWindowEnd: string;   // "HH:MM" in EST (from sequence)
  accountId: string;
}

interface PostConnectionInput {
  connectionAcceptedAt: string; // ISO timestamp
  hardcodedHours: number; // default 4
  delayIntervalMinutes: number;
  jiggleMinutes: number;
  channel: string;
  respectSendWindow: boolean;
  sendWindowStart: string;
  sendWindowEnd: string;
  accountId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EST conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get EST date components from a UTC Date. */
function toEST(date: Date): { year: number; month: number; day: number; hours: number; minutes: number } {
  const estStr = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  const parsed = new Date(estStr);
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth(),
    day: parsed.getDate(),
    hours: parsed.getHours(),
    minutes: parsed.getMinutes(),
  };
}

/** Create a UTC Date from EST components. */
function fromEST(year: number, month: number, day: number, hours: number, minutes: number): Date {
  // Create a date string in EST and convert to UTC
  const estStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

  // Use Intl to figure out the UTC offset for this EST datetime
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  // Approximate: EST is UTC-5, EDT is UTC-4. Use the date to determine.
  const testDate = new Date(`${estStr}Z`);
  const estParts = toEST(testDate);

  // Calculate offset by comparing
  const utcDate = new Date(testDate.getTime());
  const diffHours = hours - estParts.hours;
  utcDate.setHours(utcDate.getHours() + diffHours);
  const diffMinutes = minutes - estParts.minutes;
  utcDate.setMinutes(utcDate.getMinutes() + diffMinutes);

  return utcDate;
}

/** Parse "HH:MM" string to hours and minutes. */
function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [h, m] = timeStr.split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

/** Convert time to minutes since midnight for comparison. */
function timeToMinutes(hours: number, minutes: number): number {
  return hours * 60 + minutes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily/hourly cap checking
// ─────────────────────────────────────────────────────────────────────────────

interface CapCheckResult {
  allowed: boolean;
  nextAvailableDate?: Date;
}

/**
 * Check daily send cap for a channel + account on a given EST date.
 * Returns whether there's capacity and the next available date if not.
 */
export async function checkDailyCap(
  supabase: any,
  accountId: string,
  channel: string,
  estDate: string, // "YYYY-MM-DD" in EST
): Promise<CapCheckResult> {
  // Get channel limits
  const { data: limit } = await supabase
    .from("channel_limits")
    .select("daily_max")
    .eq("channel", channel)
    .maybeSingle();

  if (!limit?.daily_max) return { allowed: true }; // No cap

  // Get current count
  const { data: log } = await supabase
    .from("daily_send_log")
    .select("count")
    .eq("account_id", accountId)
    .eq("channel", channel)
    .eq("send_date", estDate)
    .maybeSingle();

  const currentCount = log?.count || 0;
  if (currentCount < limit.daily_max) return { allowed: true };

  return { allowed: false };
}

/**
 * Check hourly send cap for a channel + account in a given hour.
 */
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

  // Count scheduled sends in the same hour
  const hourStart = new Date(scheduledAt);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

  const { count } = await supabase
    .from("sequence_step_logs")
    .select("id", { count: "exact", head: true })
    .eq("channel", channel)
    .gte("scheduled_at", hourStart.toISOString())
    .lt("scheduled_at", hourEnd.toISOString())
    .in("status", ["scheduled", "sent"]);

  if ((count || 0) < limit.hourly_max) return { allowed: true };

  return { allowed: false };
}

/**
 * Increment the daily send count for an account + channel.
 * Call this after a send is confirmed.
 */
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
    await supabase
      .from("daily_send_log")
      .update({ count: existing.count + 1 })
      .eq("id", existing.id);
  } else {
    await supabase.from("daily_send_log").insert({
      account_id: accountId,
      channel,
      send_date: estDate,
      count: 1,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main send time calculator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the optimal send time for a sequence action.
 *
 * 1. Start from enrolled_at + base_delay_hours + delay_interval_minutes
 * 2. Apply jiggle (random offset)
 * 3. linkedin_connection → send anytime 24/7
 * 4. Other channels → clamp to send window (EST)
 * 5. Check daily cap → roll to next day if at limit
 * 6. Check hourly cap → move to next hour within window
 * 7. Randomize exact minute within assigned hour
 */
export async function calculateSendTime(
  supabase: any,
  input: SendTimeInput,
): Promise<Date> {
  const base = new Date(input.enrolledAt);

  // Add base delay
  base.setTime(base.getTime() + input.baseDelayHours * 60 * 60 * 1000);
  base.setTime(base.getTime() + input.delayIntervalMinutes * 60 * 1000);

  // Apply jiggle
  if (input.jiggleMinutes > 0) {
    const jiggle = Math.floor(Math.random() * input.jiggleMinutes * 2) - input.jiggleMinutes;
    base.setTime(base.getTime() + jiggle * 60 * 1000);
  }

  // LinkedIn connections send 24/7 — skip window/cap checks
  if (input.channel === "linkedin_connection") {
    // Still randomize minute within the hour
    base.setMinutes(Math.floor(Math.random() * 60));
    return base;
  }

  // Clamp to send window
  let result = clampToSendWindow(base, input.sendWindowStart, input.sendWindowEnd);

  // Check daily cap — roll forward if needed
  for (let attempts = 0; attempts < 14; attempts++) {
    const est = toEST(result);
    const estDate = `${est.year}-${String(est.month + 1).padStart(2, "0")}-${String(est.day).padStart(2, "0")}`;

    const dailyCheck = await checkDailyCap(supabase, input.accountId, input.channel, estDate);
    if (dailyCheck.allowed) break;

    // Roll to next day, at window start
    const windowStart = parseTime(input.sendWindowStart);
    const nextDay = new Date(result);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextEst = toEST(nextDay);
    result = fromEST(nextEst.year, nextEst.month, nextEst.day, windowStart.hours, windowStart.minutes);

    logger.info("Daily cap hit, rolling to next day", { channel: input.channel, estDate });
  }

  // Check hourly cap — move to next hour within window
  for (let attempts = 0; attempts < 24; attempts++) {
    const hourlyCheck = await checkHourlyCap(supabase, input.accountId, input.channel, result);
    if (hourlyCheck.allowed) break;

    // Move to next hour
    result = new Date(result.getTime() + 60 * 60 * 1000);
    result.setMinutes(0, 0, 0);

    // Re-check send window
    result = clampToSendWindow(result, input.sendWindowStart, input.sendWindowEnd);
  }

  // Randomize exact minute within the assigned hour
  result.setMinutes(Math.floor(Math.random() * 60));
  result.setSeconds(Math.floor(Math.random() * 60));

  return result;
}

/**
 * Calculate send time for a post-connection-accepted message.
 * connection_accepted_at + 4h hardcoded + delay + jiggle → clamp to window → caps.
 */
export async function calculatePostConnectionSendTime(
  supabase: any,
  input: PostConnectionInput,
): Promise<Date> {
  const base = new Date(input.connectionAcceptedAt);

  // 4 hour hardcoded minimum
  base.setTime(base.getTime() + input.hardcodedHours * 60 * 60 * 1000);

  // Add delay interval
  base.setTime(base.getTime() + input.delayIntervalMinutes * 60 * 1000);

  // Apply jiggle
  if (input.jiggleMinutes > 0) {
    const jiggle = Math.floor(Math.random() * input.jiggleMinutes * 2) - input.jiggleMinutes;
    base.setTime(base.getTime() + jiggle * 60 * 1000);
  }

  // Clamp to send window
  let result = clampToSendWindow(base, input.sendWindowStart, input.sendWindowEnd);

  // Check caps (same as regular sends)
  for (let attempts = 0; attempts < 14; attempts++) {
    const est = toEST(result);
    const estDate = `${est.year}-${String(est.month + 1).padStart(2, "0")}-${String(est.day).padStart(2, "0")}`;
    const dailyCheck = await checkDailyCap(supabase, input.accountId, input.channel, estDate);
    if (dailyCheck.allowed) break;

    const windowStart = parseTime(input.sendWindowStart);
    const nextDay = new Date(result);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextEst = toEST(nextDay);
    result = fromEST(nextEst.year, nextEst.month, nextEst.day, windowStart.hours, windowStart.minutes);
  }

  for (let attempts = 0; attempts < 24; attempts++) {
    const hourlyCheck = await checkHourlyCap(supabase, input.accountId, input.channel, result);
    if (hourlyCheck.allowed) break;
    result = new Date(result.getTime() + 60 * 60 * 1000);
    result.setMinutes(0, 0, 0);
    result = clampToSendWindow(result, input.sendWindowStart, input.sendWindowEnd);
  }

  result.setMinutes(Math.floor(Math.random() * 60));
  result.setSeconds(Math.floor(Math.random() * 60));

  return result;
}

/**
 * Clamp a timestamp to fall within the send window (EST).
 * If outside, rolls forward to the next window open.
 */
function clampToSendWindow(date: Date, windowStartStr: string, windowEndStr: string): Date {
  const est = toEST(date);
  const windowStart = parseTime(windowStartStr);
  const windowEnd = parseTime(windowEndStr);

  const currentMinutes = timeToMinutes(est.hours, est.minutes);
  const startMinutes = timeToMinutes(windowStart.hours, windowStart.minutes);
  const endMinutes = timeToMinutes(windowEnd.hours, windowEnd.minutes);

  // Within window → return as-is
  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return date;
  }

  // Before window today → move to window start today
  if (currentMinutes < startMinutes) {
    return fromEST(est.year, est.month, est.day, windowStart.hours, windowStart.minutes);
  }

  // After window → roll to next day window start
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextEst = toEST(nextDay);
  return fromEST(nextEst.year, nextEst.month, nextEst.day, windowStart.hours, windowStart.minutes);
}
