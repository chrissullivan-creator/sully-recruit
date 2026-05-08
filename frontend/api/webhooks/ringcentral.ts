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

  // Verify the request is from RingCentral. When the env var is set we
  // REQUIRE the verification-token header to match — the previous "only
  // check when both are present" gate let pre-rotation subscriptions
  // bypass auth indefinitely. Set RINGCENTRAL_WEBHOOK_STRICT=false (env)
  // during a subscription rotation if you need to temporarily fall
  // through to log-and-accept.
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
