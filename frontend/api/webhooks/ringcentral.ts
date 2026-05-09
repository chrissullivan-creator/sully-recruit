import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";

/**
 * Vercel serverless function — RingCentral webhook receiver. Handles
 * the validation challenge and fans the real event into Inngest via
 * `webhooks/ringcentral.received`. The Inngest function in
 * `api/lib/inngest/functions/process-ringcentral-event.ts` does the
 * matching, logging, and chained transcription dispatch.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // RingCentral sends a validation token on subscription setup
  if (req.body?.validationToken) {
    return res.status(200).json({ validationToken: req.body.validationToken });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the request is from RingCentral. When the env var is set we
  // REQUIRE the verification-token header to match. Set
  // RINGCENTRAL_WEBHOOK_STRICT=false during a subscription rotation to
  // temporarily fall through to log-and-accept.
  const expectedToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
  const strict = (process.env.RINGCENTRAL_WEBHOOK_STRICT ?? "true").toLowerCase() !== "false";
  const incomingToken = req.headers["verification-token"];
  if (expectedToken) {
    if (!incomingToken || incomingToken !== expectedToken) {
      console.warn("RingCentral webhook: token mismatch", {
        strict,
        hasHeader: !!incomingToken,
        expectedPrefix: expectedToken.slice(0, 6),
      });
      if (strict) {
        return res.status(401).json({ error: "Invalid verification token" });
      }
    }
  }

  try {
    await inngest.send({
      name: "webhooks/ringcentral.received",
      data: {
        body: req.body,
        headers: {
          "validation-token": req.headers["validation-token"],
        },
        receivedAt: new Date().toISOString(),
      },
    });

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("RingCentral webhook error:", err.message);
    // Still return 200 to prevent RingCentral from retrying
    return res.status(200).json({ received: true, error: "processing_queued" });
  }
}
