import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function — Clay webhook receiver.
 * Receives enriched contact/candidate data from Clay tables,
 * fires Trigger.dev task for processing.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional: verify webhook shared secret
  const webhookSecret = process.env.CLAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const headerSecret = req.headers["x-clay-secret"] || req.headers["x-webhook-secret"];
    if (headerSecret !== webhookSecret) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
  }

  try {
    await tasks.trigger("process-clay-enrichment", {
      body: req.body,
      receivedAt: new Date().toISOString(),
    });

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("Clay webhook error:", err.message);
    return res.status(200).json({ received: true, error: "processing_queued" });
  }
}
