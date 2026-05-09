import { task } from "@trigger.dev/sdk/v3";
import { inngest } from "../../api/lib/inngest/client.js";

interface Payload {
  callLogId: string;
}

/**
 * Trigger.dev wrapper around the Inngest `extract-manual-call-intel`
 * function. The body lives in
 * `api/lib/inngest/functions/extract-manual-call-intel.ts`.
 *
 * Kept so the `/api/trigger-extract-call-intel.ts` route keeps working
 * via `extractManualCallIntel.trigger(...)` until it migrates to
 * `inngest.send("messages/extract-call-intel.requested")`.
 */
export const extractManualCallIntel = task({
  id: "extract-manual-call-intel",
  retry: { maxAttempts: 1 },
  run: async (payload: Payload) => {
    const { ids } = await inngest.send({
      name: "messages/extract-call-intel.requested",
      data: payload,
    });
    return { dispatched: true, eventId: ids[0] };
  },
});
