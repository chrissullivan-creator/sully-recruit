import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * RingCentral webhook — thin receiver.
 *
 * Two responsibilities only:
 *   1. Echo RC's `validation-token` header back as a response header on
 *      every subscription create + renewal. Without it, RC drops the
 *      subscription.
 *   2. Forward the raw body to Inngest as `webhooks/ringcentral.received`
 *      with shape `{ body, headers, receivedAt }` —
 *      process-ringcentral-event consumes exactly that shape (see
 *      api/lib/inngest/functions/process-ringcentral-event.ts).
 *
 * All the real work (entity match, call_logs / messages insert, recording
 * fetch, transcript trigger, sentiment, reply-stop) lives in the Inngest
 * function. Mirrors the unipile-webhook + outlook-webhook thin-receiver
 * pattern so all three providers go through the same path: HTTP receiver
 * → Inngest → DB write.
 *
 * Always returns 200 so a transient Inngest hiccup never causes RC to
 * mark the subscription unhealthy.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, validation-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendInngestEvent(name: string, data: unknown): Promise<void> {
  const eventKey = Deno.env.get("INNGEST_EVENT_KEY") || "";
  if (!eventKey) throw new Error("INNGEST_EVENT_KEY not configured");
  const resp = await fetch(`https://inn.gs/e/${encodeURIComponent(eventKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Inngest send failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // ── RC subscription validation handshake ────────────────────────
  // RC posts with header `validation-token: <token>` on every subscription
  // create + renewal. We must echo the token back in a response header.
  const validationToken = req.headers.get("validation-token");
  if (validationToken) {
    return new Response(null, {
      status: 200,
      headers: { ...corsHeaders, "validation-token": validationToken },
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Capture headers for the Inngest function (it may want timestamp /
  // signature later — process-ringcentral-event accepts them).
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;
  const receivedAt = new Date().toISOString();

  try {
    await sendInngestEvent("webhooks/ringcentral.received", { body, headers, receivedAt });
    return json({ received: true });
  } catch (err: any) {
    console.error("ringcentral-webhook: Inngest forward failed:", err.message);
    // Always 200 so RC doesn't retry-storm. The Inngest function dedupes
    // by provider_message_id, so a manual replay is safe.
    return json({ received: true, error: "processing_queued" });
  }
});
