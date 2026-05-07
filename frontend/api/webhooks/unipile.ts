import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

/**
 * Vercel serverless function — Unipile webhook receiver.
 *
 * Receives LinkedIn + Outlook events (Unipile webhook id
 * we_01kr07faywen98ywh3z8b52d5n is configured to listen to all 31
 * event types) and fires the `process-unipile-event` Trigger.dev task
 * for processing.
 *
 * Auth: shared "secret signature" Unipile sends in a header. Across
 * Unipile builds we've seen all of:
 *   - X-Unipile-Secret / X-Webhook-Secret / X-Unipile-Signature: <secret verbatim>
 *   - X-Unipile-Signature: hmac-sha256(body, secret) hex-encoded
 *   - Authorization: Bearer <secret>
 * The verifier accepts any of these. Resolved from env
 * (`UNIPILE_WEBHOOK_SECRET`) first, then `app_settings` row of the
 * same name. Mismatch = 401. When neither is configured the receiver
 * accepts everything (dev convenience).
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

  // Previously we accepted unsigned payloads when the secret was not
  // configured ("dev convenience"). That meant any caller who guessed the
  // URL could enqueue process-unipile-event runs. Refuse if unset.
  if (!expectedSecret) {
    console.error("Unipile webhook: UNIPILE_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }
  if (!verifyUnipileSecret(req, expectedSecret)) {
    // Log header names + an 8-char prefix of every value so we can
    // see WHICH header is carrying Unipile's secret signature on a
    // fresh install. Truncated to keep the secret out of logs.
    const headerSnapshot: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const s = Array.isArray(v) ? v.join(",") : String(v ?? "");
      headerSnapshot[k] = s.length > 0 ? s.slice(0, 8) + "…" : "";
    }
    console.warn("Unipile webhook: secret mismatch", {
      expectedPrefix: expectedSecret.slice(0, 8),
      headers: headerSnapshot,
    });
    return res.status(401).json({ error: "Invalid webhook secret" });
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

/**
 * Accept the shared secret in any of the formats Unipile uses across
 * versions. Returns true on the first match.
 *   1. Raw secret in any "secret"/"signature"/"webhook" header
 *   2. Raw secret in `Authorization: Bearer <secret>`
 *   3. HMAC-SHA256(body, secret) hex in any signature header
 */
function verifyUnipileSecret(req: VercelRequest, secret: string): boolean {
  const headers = req.headers;

  // Path 1 + 2: raw secret check across likely headers.
  const candidates = [
    headers["x-unipile-secret"],
    headers["x-webhook-secret"],
    headers["x-unipile-signature"],
    headers["x-webhook-signature"],
    headers["x-signature"],
    headers["unipile-signature"],
    typeof headers.authorization === "string"
      ? headers.authorization.replace(/^Bearer\s+/i, "")
      : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c && timingSafeEqual(c, secret)) return true;
  }

  // Path 3: HMAC-SHA256 of the raw body using the secret as the key.
  // Vercel parses JSON bodies into `req.body` by default, so we
  // recompute the canonical JSON to hash. If the body is a string
  // (raw mode) we hash it directly.
  const sigHeader = String(
    headers["x-unipile-signature"]
      || headers["x-webhook-signature"]
      || headers["x-signature"]
      || "",
  ).trim();
  if (sigHeader) {
    try {
      const raw = typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {});
      const hmac = crypto
        .createHmac("sha256", secret)
        .update(raw)
        .digest("hex");
      // Some senders prefix `sha256=` — strip it before comparing.
      const cleaned = sigHeader.replace(/^sha256=/i, "");
      if (timingSafeEqual(hmac, cleaned)) return true;
    } catch { /* fall through to false */ }
  }

  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
