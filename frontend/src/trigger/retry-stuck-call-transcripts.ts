import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { processCallDeepgram } from "./process-call-deepgram";

/**
 * Safety net for calls whose transcripts never made it to ai_call_notes.
 *
 * Why this exists: RingCentral recordings aren't always ready when
 * poll-rc-calls or the RC webhook fires processCallDeepgram on a fresh
 * call_log. When the recording is missing, processCallDeepgram silently
 * increments `stats.no_recording++` and returns without writing a row —
 * so the call sits forever unless somebody runs the batch from the
 * Trigger.dev dashboard.
 *
 * This sweep re-fires processCallDeepgram for any eligible call_log
 * that's still missing an ai_call_notes row, after a short grace
 * period (recording usually appears within a few minutes) and within a
 * cap (give up after 7 days).
 *
 * Schedule: every 15 minutes.
 */
export const retryStuckCallTranscripts = schedules.task({
  id: "retry-stuck-call-transcripts",
  cron: "*/15 * * * *",
  maxDuration: 600,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Pull eligible call_logs in the retry window (5 min .. 7 days old).
    const { data: eligible } = await supabase
      .from("call_logs")
      .select("id, started_at, duration_seconds, linked_entity_name, external_call_id")
      .eq("status", "completed")
      .gte("duration_seconds", 30)
      .gte("started_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .lte("started_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order("started_at", { ascending: false })
      .limit(200);

    if (!eligible?.length) {
      logger.info("No eligible call_logs in window");
      return { triggered: 0, scanned: 0 };
    }

    // Filter out ones that already have notes.
    const ids = eligible.map((c: any) => c.id);
    const { data: existing } = await supabase
      .from("ai_call_notes")
      .select("call_log_id")
      .in("call_log_id", ids);
    const noted = new Set((existing ?? []).map((r: any) => r.call_log_id));
    const stuck = eligible.filter((c: any) => !noted.has(c.id));

    if (!stuck.length) {
      logger.info("All eligible calls already have notes", { scanned: eligible.length });
      return { triggered: 0, scanned: eligible.length };
    }

    // Cap fan-out per run so we don't blast the queue.
    const toRetry = stuck.slice(0, 25);
    let triggered = 0;
    for (const cl of toRetry) {
      try {
        await processCallDeepgram.trigger({ call_log_id: cl.id });
        triggered++;
      } catch (err: any) {
        logger.warn("Retry trigger failed", { callLogId: cl.id, error: err.message });
      }
    }

    logger.info("Stuck-call retry sweep done", {
      scanned: eligible.length,
      stuck: stuck.length,
      triggered,
      examples: toRetry.slice(0, 5).map((c: any) => ({
        id: c.id,
        name: c.linked_entity_name,
        duration: c.duration_seconds,
        age_min: Math.round((Date.now() - new Date(c.started_at).getTime()) / 60000),
      })),
    });

    return { triggered, scanned: eligible.length, stuck: stuck.length };
  },
});
