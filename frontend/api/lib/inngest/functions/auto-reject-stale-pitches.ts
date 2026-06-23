import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Auto-reject stale pitches.
 *
 * Business rule (June 2026): a send-out sitting in the Pitch queue for more
 * than N days (default 14) with no activity is automatically moved to the
 * Rejected terminal stage. "Pitch queue" = the canonical Pitch funnel tile,
 * i.e. send_outs.stage in the pitch synonym set — kept in sync with
 * CANONICAL_PIPELINE['pitch'].pipelineStageValues in src/lib/pipeline.ts.
 *
 * Staleness is measured by `updated_at`. There's no dedicated stage-entry
 * timestamp on send_outs, but pitches are created in the pitch stage and sit
 * untouched (verified live: every pitch row has updated_at == created_at), and
 * any real activity — notes, a stage nudge — bumps updated_at. So updated_at is
 * the truest "time since last touch", and an actively worked pitch is never
 * auto-rejected.
 *
 * Tunable via app_settings (no deploy needed):
 *   - PITCH_AUTO_REJECT_DAYS    integer, default 14
 *   - PITCH_AUTO_REJECT_PAUSED  'true' | '1' | 'on' to disable
 *
 * Idempotent: only pitch-stage rows are selected, so a row rejected on one run
 * is out of scope on the next. Daily at 08:00 UTC (~4am ET, before the workday).
 */

// Raw stage values that the app groups under the canonical "Pitch" tile.
// Mirrors src/lib/pipeline.ts CANONICAL_PIPELINE — duplicated (not imported)
// to keep this serverless function free of the frontend lib bundle.
const PITCH_STAGE_VALUES = ["pitch", "pitched", "new"];
const DEFAULT_DAYS = 14;

async function runAutoRejectStalePitches(logger: any) {
  const supabase = getSupabaseAdmin();

  const paused = (await getAppSetting("PITCH_AUTO_REJECT_PAUSED")).toLowerCase();
  if (paused === "true" || paused === "1" || paused === "on") {
    logger.info("auto-reject-stale-pitches paused via app_settings.PITCH_AUTO_REJECT_PAUSED");
    return { paused: true };
  }

  let days = DEFAULT_DAYS;
  const rawDays = parseInt(await getAppSetting("PITCH_AUTO_REJECT_DAYS"), 10);
  if (Number.isFinite(rawDays) && rawDays > 0) days = rawDays;

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // Select first so the run log lists exactly which send-outs flipped — the
  // rejected_by='system' stamp on the rows is the durable audit trail.
  const { data: stale, error: selErr } = await supabase
    .from("send_outs")
    .select("id, candidate_id, job_id")
    .in("stage", PITCH_STAGE_VALUES)
    .lt("updated_at", cutoff)
    .is("deleted_at", null);

  if (selErr) {
    await notifyError({ taskId: "auto-reject-stale-pitches", error: selErr, context: { days } });
    return { error: selErr.message };
  }
  if (!stale?.length) {
    logger.info("No stale pitches to auto-reject", { days, cutoff });
    return { rejected: 0, days };
  }

  const ids = stale.map((s: any) => s.id);
  const reason = `Auto-rejected: ${days}+ days in pitch with no activity`;

  // Mark via the auto-reject field convention (rejected_by/rejection_reason, as
  // intel-extraction does) AND withdrawn_reason (what the manual reject UI shows)
  // so the reason is visible wherever rejections are read. withdrawn_by_party is
  // left NULL — its CHECK only allows candidate/client/recruiter/salesperson, and
  // none represent an automated actor.
  const { error: updErr } = await supabase
    .from("send_outs")
    .update({
      stage: "rejected",
      rejected_by: "system",
      rejection_reason: reason,
      withdrawn_reason: reason,
      updated_at: new Date().toISOString(),
    } as any)
    .in("id", ids);

  if (updErr) {
    await notifyError({ taskId: "auto-reject-stale-pitches", error: updErr, context: { days, count: ids.length } });
    return { error: updErr.message };
  }

  logger.info("Auto-rejected stale pitches", { count: ids.length, days, ids });
  return { rejected: ids.length, days };
}

export const autoRejectStalePitches = inngest.createFunction(
  { id: "auto-reject-stale-pitches", name: "Auto-reject stale pitches (Inngest)" },
  { cron: "0 8 * * *" },
  async ({ logger }) => runAutoRejectStalePitches(logger),
);
