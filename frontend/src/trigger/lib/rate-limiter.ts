/**
 * Per-channel, per-user rate limiting for sequence sends.
 *
 * Daily + hourly caps prevent burst sends and platform throttling.
 * Scoped to enrolled_by user so Chris, Nancy, Ashley don't starve each other.
 */
import { logger } from "@trigger.dev/sdk/v3";

interface ChannelCap {
  daily: number;
  hourly: number;
}

const CHANNEL_CAPS: Record<string, ChannelCap> = {
  email: { daily: 150, hourly: 15 },
  linkedin_connection: { daily: 40, hourly: 8 },
  linkedin_message: { daily: 50, hourly: 10 },
  classic_message: { daily: 50, hourly: 10 },
  sms: { daily: 50, hourly: 10 },
};

// Channels that skip rate limiting entirely
const EXEMPT_CHANNELS = new Set([
  "linkedin_recruiter",
  "recruiter_inmail",
  "sales_nav",
  "sales_nav_inmail",
]);

/** Normalize channel to its rate-limit category. */
function channelCategory(channel: string): string | null {
  if (EXEMPT_CHANNELS.has(channel)) return null;
  if (channel === "linkedin_connection") return "linkedin_connection";
  if (channel === "linkedin_message" || channel === "classic_message") return "linkedin_message";
  if (channel === "sms") return "sms";
  if (channel === "email") return "email";
  // Unknown → treat as email for safety
  return "email";
}

/** Check whether a channel matches a rate-limit category. */
function matchesCategory(stepChannel: string, category: string): boolean {
  if (category === "linkedin_connection") return stepChannel === "linkedin_connection";
  if (category === "linkedin_message")
    return stepChannel === "linkedin_message" || stepChannel === "classic_message";
  if (category === "sms") return stepChannel === "sms";
  return stepChannel === "email";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAt?: Date;
  reason?: "hourly_cap" | "daily_cap";
  dailyCount?: number;
  hourlyCount?: number;
}

/**
 * Check whether a send is allowed under per-channel, per-user rate limits.
 *
 * @param supabase   Admin client
 * @param channel    The step's channel (email, linkedin_message, sms, etc.)
 * @param userId     The enrolled_by user — limits are scoped per user
 * @param sendStart  UTC hour when send window opens (for reschedule calculation)
 */
export async function checkRateLimit(
  supabase: any,
  channel: string,
  userId: string,
  now: Date,
  sendStart: number,
): Promise<RateLimitResult> {
  const category = channelCategory(channel);
  if (!category) return { allowed: true }; // InMails are exempt

  const caps = CHANNEL_CAPS[category] ?? { daily: 150, hourly: 15 };

  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Fetch today's executions scoped to this user via enrollment join
  const { data: todayExecs } = await supabase
    .from("sequence_step_executions")
    .select("id, sequence_step_id, executed_at, sequence_enrollments!inner(enrolled_by)")
    .eq("sequence_enrollments.enrolled_by", userId)
    .gte("executed_at", todayStart.toISOString())
    .in("status", ["sent"]);

  if (!todayExecs || todayExecs.length === 0) {
    return { allowed: true, dailyCount: 0, hourlyCount: 0 };
  }

  // Get the step IDs to check their channels + enrolled_by user
  const stepIds = [...new Set(todayExecs.map((e: any) => e.sequence_step_id))];
  const { data: steps } = await supabase
    .from("sequence_steps")
    .select("id, channel, step_type")
    .in("id", stepIds);

  // Also filter by enrolled_by user via enrollments
  const enrollmentIds = [...new Set(todayExecs.map((e: any) => e.enrollment_id))];

  // Build set of step IDs that match our channel category
  const matchingStepIds = new Set(
    (steps ?? [])
      .filter((s: any) => matchesCategory(s.channel || s.step_type || "", category))
      .map((s: any) => s.id),
  );

  let dailyCount = 0;
  let hourlyCount = 0;

  for (const exec of todayExecs) {
    if (matchingStepIds.has(exec.sequence_step_id)) {
      dailyCount++;
      if (new Date(exec.executed_at) >= oneHourAgo) {
        hourlyCount++;
      }
    }
  }

  // Hourly cap → reschedule 30-60 min from now
  if (hourlyCount >= caps.hourly) {
    const retryAt = new Date(now.getTime() + (30 + Math.floor(Math.random() * 30)) * 60 * 1000);
    logger.info("Hourly cap reached", { channel: category, cap: caps.hourly, count: hourlyCount });
    return { allowed: false, retryAt, reason: "hourly_cap", dailyCount, hourlyCount };
  }

  // Daily cap → reschedule to tomorrow morning
  if (dailyCount >= caps.daily) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(sendStart, Math.floor(Math.random() * 45), 0, 0);
    logger.info("Daily cap reached", { channel: category, cap: caps.daily, count: dailyCount });
    return { allowed: false, retryAt: tomorrow, reason: "daily_cap", dailyCount, hourlyCount };
  }

  return { allowed: true, dailyCount, hourlyCount };
}
