import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function — Microsoft Graph webhook receiver.
 * Handles subscription validation and fires Trigger.dev task for notifications.
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
    const notifications = req.body?.value || [];

    // Trigger a task for each notification
    for (const notification of notifications) {
      await tasks.trigger("process-microsoft-event", {
        notification,
        receivedAt: new Date().toISOString(),
      });
    }

    return res.status(202).json({ received: true });
  } catch (err: any) {
    console.error("Microsoft Graph webhook error:", err.message);
    return res.status(202).json({ received: true, error: "processing_queued" });
  }
}
