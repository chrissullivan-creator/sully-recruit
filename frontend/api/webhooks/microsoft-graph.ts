import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../../src/inngest/client";

/**
 * Vercel serverless function — Microsoft Graph webhook receiver.
 *
 * Pairs with the `process-microsoft-event` Inngest function in
 * src/inngest/functions/process-microsoft-event.ts. Microsoft requires
 * a <3s response to webhook calls or it disables the subscription, so
 * this file does the bare minimum (validation + event dispatch) and
 * the worker does the real processing.
 *
 * Auth: Microsoft Graph echoes the `clientState` we set during
 * subscription creation back on every notification. Verify it matches
 * MICROSOFT_WEBHOOK_CLIENT_STATE before queueing — without this the
 * URL is open to anyone who guesses it.
 *
 * Migrated from Trigger.dev (`tasks.trigger("process-microsoft-event")`)
 * as part of Phase 4c — sends `microsoft/notification-received` events
 * into Inngest now. The Trigger.dev task wrapper still exists in
 * src/trigger/webhook-microsoft.ts and shares the same run body via
 * `runProcessMicrosoftEvent`; Phase 5b deletes the wrapper.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Microsoft Graph subscription validation handshake — return
  // validationToken as plain text. Unsigned by design (Microsoft uses
  // it to confirm we own the URL).
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
    const events: Array<{ name: string; data: any; id?: string }> = [];

    for (const notification of notifications) {
      const got = String(notification?.clientState ?? "");
      if (expectedState && got !== expectedState) {
        console.warn("MS Graph webhook: clientState mismatch", {
          strict,
          hasState: !!got,
          expectedPrefix: expectedState.slice(0, 6),
          subscription: notification?.subscriptionId,
        });
        if (strict) { dropped++; continue; }
      }
      events.push({
        name: "microsoft/notification-received",
        // Inngest dedupes by event id — the per-subscription change
        // token + tenant-resource is unique per notification, so a
        // Microsoft retry on the same notification doesn't double-process.
        id: `ms-${notification?.subscriptionId}-${notification?.subscriptionExpirationDateTime ?? ""}-${notification?.resourceData?.id ?? ""}-${notification?.changeType ?? ""}`,
        data: {
          notification,
          receivedAt: new Date().toISOString(),
          verified: !expectedState ? null : got === expectedState,
        },
      });
      queued++;
    }

    if (events.length > 0) {
      // Single inngest.send call — accepts an array, fanning out one
      // function run per event.
      await inngest.send(events);
    }

    return res.status(202).json({ received: true, queued, dropped });
  } catch (err: any) {
    console.error("Microsoft Graph webhook error:", err.message);
    return res.status(202).json({ received: true, error: "processing_queued" });
  }
}
