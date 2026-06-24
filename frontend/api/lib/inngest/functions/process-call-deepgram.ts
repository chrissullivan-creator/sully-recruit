import { inngest } from "../client.js";
import { runProcessCallDeepgram } from "../../../../src/server-lib/call-deepgram-runner.js";

/**
 * Inngest mirror of Trigger.dev's `processCallDeepgram` task. The body
 * lives in `src/server-lib/call-deepgram-runner.ts` so both engines
 * drive the exact same RC fetch → Deepgram → Joe extract → DB write
 * pipeline.
 *
 * `retries: 2` matches Trigger.dev's `maxAttempts: 2`. Concurrency
 * keyed on call_log_id when present so a duplicate event for the same
 * call can't double-write ai_call_notes (the upsert there is keyed on
 * external_call_id which is also unique, but the concurrency guard
 * saves a Deepgram call).
 */
export const processCallDeepgram = inngest.createFunction(
  {
    id: "process-call-deepgram",
    name: "Transcribe + extract intel from RC call (Inngest)",
    retries: 2,
    concurrency: [{ key: "event.data.call_log_id", limit: 1 }],
  },
  { event: "call/transcribe.requested" },
  async ({ event, logger }) => {
    const result = await runProcessCallDeepgram(event.data, logger);
    // Refresh the Joe Says brief for everyone this call enriched, so the
    // freshly extracted transcript intel lands in their summary. Best-effort:
    // a failed event send must not fail the (already-committed) transcription.
    for (const t of (result as any)?.joeSaysTargets ?? []) {
      try {
        await inngest.send({
          name: "ai/joe-says.requested",
          data: { entityId: t.entityId, entityType: t.entityType },
        });
      } catch (err: any) {
        logger.warn("joe-says fire after deepgram failed", { error: err?.message, entityId: t.entityId });
      }
    }
    return result;
  },
);
