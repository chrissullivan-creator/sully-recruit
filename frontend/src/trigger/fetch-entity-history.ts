import { task } from "@trigger.dev/sdk/v3";
import { inngest } from "../../api/lib/inngest/client.js";

/**
 * Trigger.dev wrapper around the Inngest `fetch-entity-history`
 * function. Body lives in
 * `api/lib/inngest/functions/fetch-entity-history.ts`.
 *
 * Kept so `/api/trigger-fetch-history.ts` keeps working via
 * `fetchEntityHistory.trigger(...)` until it migrates to
 * `inngest.send("messages/fetch-entity-history.requested")`.
 */
export const fetchEntityHistory = task({
  id: "fetch-entity-history",
  retry: { maxAttempts: 1 },
  run: async (payload: { contact_id: string }) => {
    const { ids } = await inngest.send({
      name: "messages/fetch-entity-history.requested",
      data: payload,
    });
    return { dispatched: true, eventId: ids[0] };
  },
});
