import { type SendOutRow, lastTouchAt } from '@/lib/queries/send-outs';
import { stageToCanonical, type CanonicalStage } from '@/lib/pipeline';

/** A send-out is "stale" / needs follow-up after this many days with no touch. */
export const FOLLOWUP_DAYS = 3;

/** Stages that count toward the active pipeline total. */
export const ACTIVE_STAGES: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted', 'interview', 'offer'];

/** Stages where a stalled card should raise a "needs follow-up" flag. */
export const FOLLOWUP_STAGES: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted', 'interview'];

/** Whole days between a timestamp and now (null-safe). */
export function daysSince(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/** Days the row has sat in its current stage (since its last stage move). */
export function daysInStage(row: SendOutRow): number {
  return daysSince(row.updated_at ?? row.created_at) ?? 0;
}

/**
 * True when an active-stage card has had no touch in FOLLOWUP_DAYS — i.e. it's
 * been sitting in Send Out / Submission / Pitch / Interview with no answer.
 */
export function needsFollowUp(row: SendOutRow): boolean {
  const stage = stageToCanonical(row.stage);
  if (!FOLLOWUP_STAGES.includes(stage)) return false;
  const d = daysSince(lastTouchAt(row));
  return d != null && d >= FOLLOWUP_DAYS;
}

function startOfWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d.getTime();
}
function endOfWeek(): number {
  return startOfWeek() + 7 * 86_400_000;
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

export interface PipelineStats {
  active: number;
  byStage: Record<CanonicalStage, number>;
  followUpByStage: Partial<Record<CanonicalStage, number>>;
  followUpTotal: number;
  placementRate: number;            // placed / (placed + active + rejected) as %
  placedThisMonth: number;
  interviewsThisWeek: number;
  notContacted: SendOutRow[];       // active rows untouched ≥ FOLLOWUP_DAYS
  submissionsWaiting: SendOutRow[]; // submitted rows untouched ≥ FOLLOWUP_DAYS
  upcomingInterviews: SendOutRow[]; // interview rows with interview_at this week
  avgDaysSubmission: number | null;
  avgDaysInterview: number | null;
  topClient: { name: string; count: number } | null;
}

/** One pass over the rows producing everything the KPI strip + panels need. */
export function computePipelineStats(rows: SendOutRow[]): PipelineStats {
  const byStage = { pitch: 0, ready_to_send: 0, submitted: 0, interview: 0, offer: 0, placed: 0, withdrawn: 0 } as Record<CanonicalStage, number>;
  const followUpByStage: Partial<Record<CanonicalStage, number>> = {};
  const notContacted: SendOutRow[] = [];
  const submissionsWaiting: SendOutRow[] = [];
  const upcomingInterviews: SendOutRow[] = [];
  const subDays: number[] = [];
  const intDays: number[] = [];
  const clientCounts = new Map<string, number>();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const wkStart = startOfWeek(), wkEnd = endOfWeek();
  let placedThisMonth = 0;

  for (const r of rows) {
    const stage = stageToCanonical(r.stage);
    byStage[stage] = (byStage[stage] ?? 0) + 1;

    if (needsFollowUp(r)) {
      followUpByStage[stage] = (followUpByStage[stage] ?? 0) + 1;
      if (ACTIVE_STAGES.includes(stage)) notContacted.push(r);
      if (stage === 'submitted') submissionsWaiting.push(r);
    }

    if (stage === 'submitted') { const d = daysInStage(r); if (d > 0) subDays.push(d); }
    if (stage === 'interview') {
      const d = daysInStage(r); if (d > 0) intDays.push(d);
      const at = r.interview_at ? new Date(r.interview_at).getTime() : null;
      if (at != null && at >= wkStart && at < wkEnd) upcomingInterviews.push(r);
    }
    if (stage === 'placed' && r.placed_at && new Date(r.placed_at).getTime() >= monthStart.getTime()) {
      placedThisMonth++;
    }

    if (ACTIVE_STAGES.includes(stage)) {
      const client = r.job?.company_name?.trim();
      if (client) clientCounts.set(client, (clientCounts.get(client) ?? 0) + 1);
    }
  }

  const active = ACTIVE_STAGES.reduce((sum, s) => sum + (byStage[s] ?? 0), 0);
  const placedTotal = byStage.placed ?? 0;
  const denom = active + placedTotal + (byStage.withdrawn ?? 0);
  const placementRate = denom > 0 ? Math.round((placedTotal / denom) * 100) : 0;

  let topClient: { name: string; count: number } | null = null;
  for (const [name, count] of clientCounts) {
    if (!topClient || count > topClient.count) topClient = { name, count };
  }

  const followUpTotal = Object.values(followUpByStage).reduce((a, b) => a + (b ?? 0), 0);

  return {
    active, byStage, followUpByStage, followUpTotal, placementRate, placedThisMonth,
    interviewsThisWeek: upcomingInterviews.length,
    notContacted, submissionsWaiting, upcomingInterviews,
    avgDaysSubmission: avg(subDays), avgDaysInterview: avg(intDays), topClient,
  };
}
