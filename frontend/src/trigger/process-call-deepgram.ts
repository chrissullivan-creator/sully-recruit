import { task, logger } from "@trigger.dev/sdk/v3";
import { runProcessCallDeepgram, type CallDeepgramPayload } from "./lib/call-deepgram-runner";

/**
 * Trigger.dev wrapper around the engine-neutral
 * `runProcessCallDeepgram` body. Kept while `webhook-ringcentral.ts`
 * is still on Trigger.dev (it calls `processCallDeepgram.trigger(...)`
 * after inserting a fresh call_log). Will be removed once that webhook
 * handler is ported to Inngest.
 *
 * The Inngest mirror lives at
 * `api/lib/inngest/functions/process-call-deepgram.ts` and listens on
 * `call/transcribe.requested`.
 */
export const processCallDeepgram = task({
  id: "process-call-deepgram",
  maxDuration: 1800,
  retry: { maxAttempts: 2 },
  run: async (payload: CallDeepgramPayload) => runProcessCallDeepgram(payload, logger),
});
