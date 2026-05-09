import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { notifyError } from "../../../../src/trigger/lib/alerting.js";

/**
 * Safety net for calls whose transcripts never made it to ai_call_notes.
 *
 * Why this exists: RingCentral recordings aren't always ready when
 * poll-rc-calls or the RC webhook fires the deepgram pipeline on a fresh
 * call_log. When the recording is missing, runProcessCallDeepgram silently
 * increments `stats.no_recording++` and returns without writing a row —
 * so the call sits forever unless somebody reruns it.
 *
 * This sweep re-fires the Inngest `call/transcribe.requested` event for
 * any eligible call_log still missing an ai_call_notes row, after a
 * 5-min grace period and within a 7-day cap.
 *
 * Every 15 minutes. Ported from
 * `src/trigger/retry-stuck-call-transcripts.ts` — Inngest is the only
 * scheduler now.
 */
export const retryStuckCallTranscripts = inngest.createFunction(
  { id: "retry-stuck-call-transcripts", name: "Retry stuck call transcripts (Inngest)" },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

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

    const toRetry = stuck.slice(0, 25);
    let triggered = 0;
    try {
      await inngest.send(
        toRetry.map((cl: any) => ({
          name: "call/transcribe.requested" as const,
          data: { call_log_id: cl.id },
        })),
      );
      triggered = toRetry.length;
    } catch (err: any) {
      await notifyError({
        taskId: "retry-stuck-call-transcripts",
        error: err,
        context: { count: toRetry.length },
      });
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
);
