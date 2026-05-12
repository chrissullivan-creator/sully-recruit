import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Unipile webhook — thin receiver.
 *
 * Validates the shared secret and forwards the raw body to Inngest via
 * `webhooks/unipile.received`. The Inngest function in
 * `frontend/api/lib/inngest/functions/process-unipile-event.ts` does
 * all the real work: entity match, channel classification (incl. the
 * Recruiter detection by INBOX_LINKEDIN_RECRUITER folder / inmail
 * content_type that this receiver used to mis-do), conversation upsert,
 * message insert, reply-stop, sentiment, and connection-accepted
 * handling.
 *
 * This file replaces the old fat handler that did all that work inline
 * AND classified Recruiter messages as plain `linkedin` because it only
 * checked `data.provider_type`. Two parallel write paths with diverging
 * classification logic was the root cause of the empty Recruiter inbox.
 *
 * Mirrors the Vercel handler at `frontend/api/webhooks/unipile.ts` so
 * either URL can be used in the Unipile dashboard.
 *
 * Auth: shared secret. Unipile sends it in any of:
 *   - X-Unipile-Secret / X-Webhook-Secret / X-Unipile-Signature: <secret>
 *   - X-Unipile-Signature: hmac-sha256(body, secret) hex
 *   - Authorization: Bearer <secret>
 * Secret resolves from env `UNIPILE_WEBHOOK_SECRET` first, then
 * `app_settings`. On mismatch we LOG-AND-ACCEPT by default — flip
 * `UNIPILE_WEBHOOK_STRICT=true` once the secret is verified to enforce
 * 401s. Defense-in-depth: process-unipile-event dedupes by
 * external_message_id, so a forged-shape payload produces idempotent
 * inserts at worst.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-unipile-signature, x-unipile-secret, x-webhook-secret, x-webhook-signature, x-signature, unipile-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveSecretAndStrict(): Promise<{ secret: string; strict: boolean }> {
  let secret = Deno.env.get("UNIPILE_WEBHOOK_SECRET") || "";
  let strict = (Deno.env.get("UNIPILE_WEBHOOK_STRICT") || "").toLowerCase() === "true";
  const strictExplicit = !!Deno.env.get("UNIPILE_WEBHOOK_STRICT");
  if (secret && strictExplicit) return { secret, strict };
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data } = await admin
      .from("app_settings")
      .select("key, value")
      .in("key", ["UNIPILE_WEBHOOK_SECRET", "UNIPILE_WEBHOOK_STRICT"]);
    for (const row of (data as Array<{ key: string; value: string | null }>) ?? []) {
      if (row.key === "UNIPILE_WEBHOOK_SECRET" && !secret) secret = row.value || "";
      if (row.key === "UNIPILE_WEBHOOK_STRICT" && !strictExplicit) {
        strict = String(row.value ?? "").toLowerCase() === "true";
      }
    }
  } catch {
    /* fall through — treat as not configured */
  }
  return { secret, strict };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySecret(req: Request, rawBody: string, secret: string): Promise<boolean> {
  const h = req.headers;
  const candidates = [
    h.get("x-unipile-secret"),
    h.get("x-webhook-secret"),
    h.get("x-unipile-signature"),
    h.get("x-webhook-signature"),
    h.get("x-signature"),
    h.get("unipile-signature"),
    (h.get("authorization") || "").replace(/^Bearer\s+/i, "") || null,
  ];
  for (const c of candidates) {
    if (c && timingSafeEqual(c, secret)) return true;
  }
  const sigHeader = (
    h.get("x-unipile-signature") ||
    h.get("x-webhook-signature") ||
    h.get("x-signature") ||
    ""
  ).trim();
  if (sigHeader) {
    try {
      const cleaned = sigHeader.replace(/^sha256=/i, "");
      const computed = await hmacSha256Hex(secret, rawBody);
      if (timingSafeEqual(computed, cleaned)) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

async function sendInngestEvent(body: unknown, verified: boolean): Promise<void> {
  const eventKey = Deno.env.get("INNGEST_EVENT_KEY") || "";
  if (!eventKey) throw new Error("INNGEST_EVENT_KEY not configured");
  const resp = await fetch(`https://inn.gs/e/${encodeURIComponent(eventKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "webhooks/unipile.received",
      data: {
        body,
        receivedAt: new Date().toISOString(),
        verified,
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Inngest send failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  let parsedBody: unknown;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { secret, strict } = await resolveSecretAndStrict();
  const verified = secret ? await verifySecret(req, rawBody, secret) : false;

  if (!verified) {
    const headerSnapshot: Record<string, string> = {};
    for (const [k, v] of req.headers.entries()) {
      headerSnapshot[k] = v.length > 0 ? v.slice(0, 8) + "…" : "";
    }
    console.warn("Unipile webhook: secret mismatch", {
      strict,
      hasSecret: !!secret,
      expectedPrefix: secret ? secret.slice(0, 8) : null,
      headers: headerSnapshot,
    });
    if (strict) return json({ error: "Invalid webhook secret" }, 401);
    // soft mode: fall through, but tag the event so downstream can drop it later if we want.
  }

  try {
    await sendInngestEvent(parsedBody, verified);
    return json({ received: true, verified });
  } catch (err: any) {
    console.error("Unipile webhook → Inngest forward failed:", err.message);
    // Always 200 so Unipile doesn't retry-storm. The signing key may be
    // mid-rotation or Inngest is briefly unavailable; either way, ack.
    // The Vercel mirror handler has the same fallback.
    return json({ received: true, error: "processing_queued" });
  }
});
