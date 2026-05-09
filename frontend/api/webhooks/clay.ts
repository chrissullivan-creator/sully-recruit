import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../../src/inngest/client";

/**
 * Vercel serverless function — Clay webhook receiver.
 * Receives enriched contact/candidate data from Clay tables, sends an
 * Inngest event for processing.
 *
 * Migrated from Trigger.dev (which fired a `process-clay-enrichment`
 * task that wasn't actually defined in this codebase) to Inngest.
 * The receiving Inngest function is in
 * frontend/src/inngest/functions/process-clay-enrichment.ts.
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
    await inngest.send({
      name: "clay/enrichment-received",
      data: {
        body: req.body,
        receivedAt: new Date().toISOString(),
      },
    });

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("Clay webhook error:", err.message);
    return res.status(200).json({ received: true, error: "processing_queued" });
  }
}
