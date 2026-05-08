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
 * The verifier accepts any of these. Secret resolved from env
 * (`UNIPILE_WEBHOOK_SECRET`) first, then `app_settings` row of the
 * same name.
 *
 * On mismatch the receiver defaults to LOG-AND-ACCEPT — the alternative
 * (401) drops every real LinkedIn message when the secret is rotated
 * or misconfigured, which we hit in production. Set
 * `UNIPILE_WEBHOOK_STRICT=true` (env or app_settings) once the secret
 * is verified to flip back to a hard 401.
 *
 * Defense-in-depth: process-unipile-event validates payload shape and
 * dedupes by external_message_id, so an attacker who guesses the URL
 * and crafts a Unipile-shaped payload would still produce idempotent
 * inserts at worst.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Resolve expected secret + strict-mode flag in one round-trip.
  let expectedSecret = process.env.UNIPILE_WEBHOOK_SECRET || "";
  let strictMode = (process.env.UNIPILE_WEBHOOK_STRICT || "").toLowerCase() === "true";
  if (!expectedSecret || !process.env.UNIPILE_WEBHOOK_STRICT) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey) {
      try {
        const admin = createClient(supabaseUrl, serviceKey);
        const { data } = await admin
          .from("app_settings")
          .select("key, value")
          .in("key", ["UNIPILE_WEBHOOK_SECRET", "UNIPILE_WEBHOOK_STRICT"]);
        for (const row of data ?? []) {
          if (row.key === "UNIPILE_WEBHOOK_SECRET" && !expectedSecret) expectedSecret = row.value || "";
          if (row.key === "UNIPILE_WEBHOOK_STRICT" && !process.env.UNIPILE_WEBHOOK_STRICT) {
            strictMode = String(row.value ?? "").toLowerCase() === "true";
          }
        }
      } catch { /* fall through — treat as not configured */ }
    }
  }

  const verified = expectedSecret ? verifyUnipileSecret(req, expectedSecret) : false;

  if (!verified) {
    // Log header names + an 8-char prefix of every value so we can
    // see WHICH header is carrying Unipile's secret signature on a
    // fresh install. Truncated to keep the secret out of logs.
    const headerSnapshot: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const s = Array.isArray(v) ? v.join(",") : String(v ?? "");
      headerSnapshot[k] = s.length > 0 ? s.slice(0, 8) + "…" : "";
    }
    console.warn("Unipile webhook: secret mismatch", {
      strict: strictMode,
      hasSecret: !!expectedSecret,
      expectedPrefix: expectedSecret ? expectedSecret.slice(0, 8) : null,
      headers: headerSnapshot,
    });
    if (strictMode) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    // soft mode: fall through and accept the webhook, but tag the
    // trigger payload so downstream can drop unverified data later if
    // we want.
  }

  try {
    await tasks.trigger("process-unipile-event", {
      body: req.body,
      receivedAt: new Date().toISOString(),
      verified,
    });
    return res.status(200).json({ received: true, verified });
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
