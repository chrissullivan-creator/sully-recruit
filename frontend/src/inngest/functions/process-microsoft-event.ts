import { inngest } from "../client";
import { runProcessMicrosoftEvent } from "../../server/webhook-microsoft";

/**
 * Heavy work for inbound Microsoft Graph notifications. The Vercel
 * webhook receiver (api/webhooks/microsoft-graph.ts) verifies
 * clientState in <100ms and emits this event; the worker fetches the
 * referenced message + handles attachments + matches to a person +
 * extracts intel + stops sequences.
 *
 * Single source of truth in `runProcessMicrosoftEvent` from the
 * Trigger.dev file.
 *
 * Concurrency keyed by subscriptionId so multiple notifications on
 * the same mailbox process serially (avoids race-conditions in the
 * conversations / messages writes).
 */
export const processMicrosoftEvent = inngest.createFunction(
  {
    id: "process-microsoft-event",
    retries: 3,
    triggers: [{ event: "microsoft/notification-received" }],
    concurrency: [{
      key: "event.data.notification.subscriptionId",
      limit: 1,
    }],
  },
  async ({ event, step }) => {
    const payload = event.data as Parameters<typeof runProcessMicrosoftEvent>[0];
    return step.run("run", () => runProcessMicrosoftEvent(payload));
  },
);
