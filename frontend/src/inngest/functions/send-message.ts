import { inngest } from "../client";
import { runSendMessage } from "../../trigger/send-message";

/**
 * Inngest port of the manual ad-hoc send-message task.
 *
 * Single source of truth lives in
 * frontend/src/trigger/send-message.ts as `runSendMessage`. This
 * function is the Inngest shell — same behaviour, different
 * orchestration.
 *
 * Triggered by `message/send-requested` events from
 * /api/trigger-send-message (the conversation UI's send buttons).
 */
export const sendMessage = inngest.createFunction(
  {
    id: "send-message",
    retries: 3,
    triggers: [{ event: "message/send-requested" }],
  },
  async ({ event, step, logger }) => {
    const payload = event.data as Parameters<typeof runSendMessage>[0];
    return step.run("run", () => runSendMessage(payload, logger));
  },
);
