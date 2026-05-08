import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function — Microsoft Graph webhook receiver.
 *
 * Pairs with the Trigger.dev `process-microsoft-event` task in
 * src/trigger/webhook-microsoft.ts. Microsoft requires a <3s response
 * to webhook calls or it disables the subscription, so this file does
 * the bare minimum (validation + queue) and the worker does the real
 * processing.
 *
 * Auth: Microsoft Graph echoes the `clientState` we set during
 * subscription creation back on every notification. Verify it matches
 * MICROSOFT_WEBHOOK_CLIENT_STATE before queueing — without this the
 * URL is open to anyone who guesses it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Microsoft Graph subscription validation — return validationToken as
  // plain text. This handshake is unsigned by design (Microsoft uses it
  // to confirm we own the URL) so we just echo it back.
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken as string);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const notifications = req.body?.value || [];
    const expectedState = process.env.MICROSOFT_WEBHOOK_CLIENT_STATE || "";
    const strict = (process.env.MICROSOFT_WEBHOOK_STRICT ?? "true").toLowerCase() !== "false";

    let queued = 0;
    let dropped = 0;
    for (const notification of notifications) {
      // clientState is the per-notification secret Microsoft sends. When
      // we configured the subscription we set it to MICROSOFT_WEBHOOK_CLIENT_STATE.
      const got = String(notification?.clientState ?? "");
      if (expectedState) {
        if (got !== expectedState) {
          console.warn("MS Graph webhook: clientState mismatch", {
            strict,
            hasState: !!got,
            expectedPrefix: expectedState.slice(0, 6),
            subscription: notification?.subscriptionId,
          });
          if (strict) { dropped++; continue; }
        }
      }
      await tasks.trigger("process-microsoft-event", {
        notification,
        receivedAt: new Date().toISOString(),
        verified: !expectedState ? null : got === expectedState,
      });
      queued++;
    }

    return res.status(202).json({ received: true, queued, dropped });
  } catch (err: any) {
    console.error("Microsoft Graph webhook error:", err.message);
    return res.status(202).json({ received: true, error: "processing_queued" });
  }
}
