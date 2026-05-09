import { inngest } from "../client";
import { runRenewWebhookSubscriptions } from "../../trigger/webhook-subscription-renewal";

/**
 * Daily 06:00 UTC: rotate Microsoft Graph + RingCentral webhook
 * subscriptions before they expire (Graph max 3d, RC max 7d). Runs
 * BEFORE the windows lapse — a missed renewal disables the live
 * webhook subscription, dropping inbound emails / SMS until the
 * next renewal cycle.
 */
export const renewWebhookSubscriptions = inngest.createFunction(
  {
    id: "renew-webhook-subscriptions",
    retries: 1,
    triggers: [
      { cron: "0 6 * * *" },
      { event: "webhooks/renew-subscriptions.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runRenewWebhookSubscriptions()),
);
