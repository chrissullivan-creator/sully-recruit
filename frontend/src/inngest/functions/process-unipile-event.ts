import { inngest } from "../client";
import { runProcessUnipileEvent } from "../../trigger/webhook-unipile";

/**
 * Heavy work for inbound Unipile webhooks (LinkedIn DMs, InMail,
 * email-via-Unipile, connection updates). The Vercel webhook
 * receiver (api/webhooks/unipile.ts) returns 202 and emits this
 * event; the worker matches to a person, extracts intel, runs
 * sentiment analysis, stops sequences on reply.
 *
 * Single source of truth in `runProcessUnipileEvent` from the
 * Trigger.dev file.
 */
export const processUnipileEvent = inngest.createFunction(
  {
    id: "process-unipile-event",
    retries: 3,
    triggers: [{ event: "unipile/event-received" }],
    concurrency: [{
      // Per-account fan-out parallelism; per-account events serialize
      // so connection-accept + first-message-after-accept can't race.
      key: "event.data.body.account_id",
      limit: 1,
    }],
  },
  async ({ event, step }) => {
    const payload = event.data as Parameters<typeof runProcessUnipileEvent>[0];
    return step.run("run", () => runProcessUnipileEvent(payload));
  },
);
