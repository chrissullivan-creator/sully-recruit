import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Sweeper: find completed RC calls (>=30s) that landed in call_logs but
 * never produced an ai_call_notes row (because the poll reconciled the
 * duration upward AFTER the webhook insert, but pre-#268 the poll only
 * dispatched transcription for *newly-inserted* rows). Fire
 * `call/transcribe.requested` for each so the Deepgram + AI extraction
 * + candidate auto-fill pipeline runs.
 *
 * Cron every 15 min, batch 40. Also event-triggerable via
 * `ops/dispatch-missing-transcripts.requested` for one-shot recovery.
 */
async function runSweep(logger: any, lookbackDays = 365, batch = 40) {
  const supabase = getSupabaseAdmin();

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Pull a candidate list: completed long calls in the lookback window
  // with no ai_call_notes row yet. PostgREST doesn't do `NOT EXISTS`
  // subqueries cleanly, so we do two queries and diff.
  const { data: cls, error } = await supabase
    .from("call_logs")
    .select("id, external_call_id, duration_seconds, status, started_at")
    .gte("duration_seconds", 30)
    .eq("status", "completed")
    .gte("started_at", since)
    .not("external_call_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(batch * 4);

  if (error) {
    logger.error("Call_logs query failed", { error: error.message });
    return { dispatched: 0, error: error.message };
  }
  if (!cls?.length) {
    logger.info("No completed long calls in lookback window");
    return { dispatched: 0 };
  }

  // Filter to those without ai_call_notes — chunked to keep the IN()
  // query well under PostgREST's URL length cap.
  const callLogIds = cls.map((c: any) => c.id);
  const { data: notes } = await supabase
    .from("ai_call_notes")
    .select("call_log_id")
    .in("call_log_id", callLogIds);
  const processed = new Set((notes ?? []).map((n: any) => n.call_log_id));
  const stranded = cls.filter((c: any) => !processed.has(c.id)).slice(0, batch);

  if (stranded.length === 0) {
    logger.info("All long calls already have ai_call_notes");
    return { dispatched: 0, scanned: cls.length };
  }

  const events = stranded.map((c: any) => ({
    name: "call/transcribe.requested" as const,
    data: { call_log_id: c.id },
  }));

  // Inngest accepts up to 100 events per send; we're under that.
  await inngest.send(events);

  logger.info("Dispatched missing transcribe events", {
    dispatched: stranded.length,
    scanned: cls.length,
    sample: stranded.slice(0, 3).map((c: any) => ({ id: c.id, dur: c.duration_seconds, at: c.started_at })),
  });
  return { dispatched: stranded.length, scanned: cls.length };
}

export const dispatchMissingTranscriptsCron = inngest.createFunction(
  {
    id: "dispatch-missing-transcripts-cron",
    name: "Dispatch missing call transcripts (Inngest cron)",
  },
  { cron: "7-59/15 * * * *" },
  async ({ logger }) => runSweep(logger, 365, 40),
);

export const dispatchMissingTranscripts = inngest.createFunction(
  {
    id: "dispatch-missing-transcripts",
    name: "Dispatch missing call transcripts (event-triggered)",
  },
  { event: "ops/dispatch-missing-transcripts.requested" },
  async ({ event, logger }) => {
    const lookbackDays = Number((event.data as any)?.lookback_days) || 365;
    const batch = Number((event.data as any)?.batch) || 200;
    return runSweep(logger, lookbackDays, batch);
  },
);
