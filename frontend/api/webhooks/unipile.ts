import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

/**
 * Vercel serverless function — Unipile webhook receiver.
 *
 * Receives LinkedIn + Outlook events (Unipile webhook id
 * we_01kr07faywen98ywh3z8b52d5n is configured to listen to all 31
 * event types) and fires the `process-unipile-event` Trigger.dev task
 * for processing.
 *
 * Auth: shared "secret signature" Unipile sends in the
 * `x-unipile-secret` (or `x-webhook-secret`) header. Resolved from
 * env (`UNIPILE_WEBHOOK_SECRET`) first, then `app_settings` row of
 * the same name. Mismatch = 401. When neither is configured the
 * receiver accepts everything (dev convenience).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Resolve expected secret: env first, then app_settings.
  let expectedSecret = process.env.UNIPILE_WEBHOOK_SECRET || "";
  if (!expectedSecret) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey) {
      try {
        const admin = createClient(supabaseUrl, serviceKey);
        const { data } = await admin
          .from("app_settings")
          .select("value")
          .eq("key", "UNIPILE_WEBHOOK_SECRET")
          .maybeSingle();
        expectedSecret = data?.value || "";
      } catch { /* fall through — treat as not configured */ }
    }
  }

  if (expectedSecret) {
    // Unipile sends the configured "Secret signature" verbatim in one
    // of these headers. We accept both names so the receiver works
    // even if their header naming flips between v1 and v2.
    const incoming = String(
      req.headers["x-unipile-secret"]
        || req.headers["x-webhook-secret"]
        || req.headers["x-unipile-signature"]
        || "",
    );
    if (incoming !== expectedSecret) {
      console.warn("Unipile webhook: secret mismatch", {
        gotPrefix: incoming.slice(0, 8),
      });
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
  }

  try {
    await tasks.trigger("process-unipile-event", {
      body: req.body,
      receivedAt: new Date().toISOString(),
    });
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("Unipile webhook error:", err.message);
    // Always 200 so Unipile doesn't retry-storm. The trigger task is
    // queued or the server is having a hiccup; either way, ack.
    return res.status(200).json({ received: true, error: "processing_queued" });
  }
}
