import { inngest } from "../client";
import { runProcessRingcentralEvent } from "../../trigger/webhook-ringcentral";

/**
 * Heavy work for RingCentral webhooks (calls + SMS). The Vercel
 * webhook receiver (api/webhooks/ringcentral.ts) returns 202 and
 * emits this event; the worker matches phone → person, fetches the
 * call recording for transcription, and stops sequences on reply.
 *
 * Single source of truth in `runProcessRingcentralEvent` from the
 * Trigger.dev file.
 */
export const processRingcentralEvent = inngest.createFunction(
  {
    id: "process-ringcentral-event",
    retries: 3,
    triggers: [{ event: "ringcentral/event-received" }],
  },
  async ({ event, step }) => {
    const payload = event.data as Parameters<typeof runProcessRingcentralEvent>[0];
    return step.run("run", () => runProcessRingcentralEvent(payload));
  },
);
