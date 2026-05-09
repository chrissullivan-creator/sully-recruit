import { inngest } from "../client";
import { runProcessCallDeepgram, type ProcessCallDeepgramPayload } from "../../trigger/process-call-deepgram";

/**
 * Long-running call transcription pipeline: Deepgram transcription +
 * Claude extraction + back-of-resume notes. Up to 30 min for 2-hour
 * recordings.
 *
 * Triggered by `call/deepgram-process.requested` events from
 * the call insert flow + drainCallQueue + retryStuckCallTranscripts.
 *
 * Per-call concurrency=1 — a duplicate event for the same call_log_id
 * (typical when both the realtime trigger + the retry sweep fire) only
 * processes once. Step memoization protects against double-billed
 * Deepgram calls if Inngest retries mid-execution.
 */
export const processCallDeepgram = inngest.createFunction(
  {
    id: "process-call-deepgram",
    retries: 2,
    triggers: [{ event: "call/deepgram-process.requested" }],
    concurrency: [{ key: "event.data.call_log_id", limit: 1 }],
  },
  async ({ event, step }) => {
    const payload = (event.data ?? {}) as ProcessCallDeepgramPayload;
    return step.run("run", () => runProcessCallDeepgram(payload));
  },
);
