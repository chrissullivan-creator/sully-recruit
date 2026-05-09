import { task } from "@trigger.dev/sdk/v3";
import { inngest } from "../../api/lib/inngest/client.js";

interface GenerateJoeSaysPayload {
  entityId: string;
  entityType: "candidate" | "contact";
}

/**
 * Trigger.dev wrapper around the Inngest `generate-joe-says` function.
 *
 * The body lives in `api/lib/inngest/functions/generate-joe-says.ts`.
 * This wrapper exists so any caller still using
 * `generateJoeSays.trigger(...)` (the in-flight Inngest webhook
 * handlers in PRs that haven't merged yet, plus the Trigger.dev
 * `webhook-microsoft` / `webhook-unipile` tasks on `main` until those
 * land) keeps working — it just dispatches an Inngest event instead of
 * doing the work directly.
 *
 * Will be deleted alongside the Trigger.dev SDK once every caller has
 * been migrated to send the `ai/joe-says.requested` event directly.
 */
export const generateJoeSays = task({
  id: "generate-joe-says",
  retry: { maxAttempts: 1 },
  run: async (payload: GenerateJoeSaysPayload) => {
    const { ids } = await inngest.send({
      name: "ai/joe-says.requested",
      data: payload,
    });
    return { dispatched: true, eventId: ids[0] };
  },
});
