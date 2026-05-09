import { task } from "@trigger.dev/sdk/v3";
import { inngest } from "../../api/lib/inngest/client.js";

interface SendMessagePayload {
  channel: "email" | "sms" | "linkedin";
  conversationId: string;
  candidateId?: string;
  contactId?: string;
  to: string;
  subject?: string;
  body: string;
  accountId?: string;
  userId: string;
}

/**
 * Trigger.dev wrapper around the Inngest `send-message` function.
 * The body lives in `api/lib/inngest/functions/send-message.ts`.
 *
 * Kept as a 25-line pass-through so any caller still using
 * `sendMessage.trigger(...)` (the `/api/trigger-send-message.ts` route
 * on `main`) keeps working until the route migrates.
 *
 * Will be deleted alongside the SDK once every caller has migrated to
 * send the `messages/send.requested` event directly.
 */
export const sendMessage = task({
  id: "send-message",
  retry: { maxAttempts: 1 },
  run: async (payload: SendMessagePayload) => {
    const { ids } = await inngest.send({
      name: "messages/send.requested",
      data: payload,
    });
    return { dispatched: true, eventId: ids[0] };
  },
});
