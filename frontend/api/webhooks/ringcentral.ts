import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function — RingCentral webhook receiver.
 * Handles validation challenge and fires Trigger.dev task for real events.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // RingCentral sends a validation token on subscription setup
  if (req.body?.validationToken) {
    return res.status(200).json({ validationToken: req.body.validationToken });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the request is from RingCentral using the verification token
  const expectedToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
  if (expectedToken && req.headers["verification-token"] !== expectedToken) {
    return res.status(401).json({ error: "Invalid verification token" });
  }

  try {
    // Fire-and-forget: trigger the processing task
    await tasks.trigger("process-ringcentral-event", {
      body: req.body,
      headers: {
        "validation-token": req.headers["validation-token"],
      },
      receivedAt: new Date().toISOString(),
    });

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("RingCentral webhook error:", err.message);
    // Still return 200 to prevent RingCentral from retrying
    return res.status(200).json({ received: true, error: "processing_queued" });
  }
}
