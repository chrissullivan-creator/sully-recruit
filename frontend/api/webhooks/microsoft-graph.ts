import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function — Microsoft Graph webhook receiver.
 *
 * Handles subscription validation and fires a Trigger.dev task for each
 * notification. Verifies the per-subscription `clientState` so we don't
 * trust a leaked webhook URL — Graph attaches the same clientState we
 * set when creating the subscription, and we drop notifications that
 * don't match. Expected value comes from the
 * MICROSOFT_GRAPH_CLIENT_STATE env var (set during subscription setup).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Microsoft Graph subscription validation — return validationToken as plain text
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken as string);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const expectedClientState = process.env.MICROSOFT_GRAPH_CLIENT_STATE;
    const notifications = req.body?.value || [];

    let dispatched = 0;
    let rejected = 0;

    for (const notification of notifications) {
      // Verify clientState if we have one configured. Reject mismatches
      // so a leaked URL can't be used to inject fake notifications.
      // Skip the check when the env var is unset (legacy deploys); log
      // so the gap is visible in Vercel logs.
      if (expectedClientState && notification.clientState !== expectedClientState) {
        console.warn("Graph webhook: clientState mismatch — dropping notification", {
          subscriptionId: notification.subscriptionId,
        });
        rejected++;
        continue;
      }
      if (!expectedClientState) {
        console.warn("Graph webhook: MICROSOFT_GRAPH_CLIENT_STATE not set — accepting unverified notification");
      }

      await tasks.trigger("process-microsoft-event", {
        notification,
        receivedAt: new Date().toISOString(),
      });
      dispatched++;
    }

    return res.status(202).json({ received: true, dispatched, rejected });
  } catch (err: any) {
    console.error("Microsoft Graph webhook error:", err.message);
    return res.status(202).json({ received: true, error: "processing_queued" });
  }
}
