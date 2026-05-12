import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Outlook (Microsoft Graph) webhook — thin receiver.
 *
 * Two responsibilities only:
 *   1. Echo Graph's subscription validation token (GET ?validationToken=…)
 *      back as text/plain — required during subscription create + every
 *      renewal. Without this, Graph drops the subscription within minutes.
 *   2. Fan out each notification in `body.value[]` to Inngest as a
 *      separate `webhooks/microsoft.received` event with shape
 *      `{ notification, receivedAt }` — process-microsoft-event consumes
 *      exactly that shape (see api/lib/inngest/functions/process-microsoft-event.ts).
 *
 * All the real work (token refresh, Graph fetch, entity match,
 * conversation upsert, attachment download + parse, sentiment, reply-stop)
 * lives in the Inngest function. Two parallel write paths with diverging
 * logic was the root cause of the LinkedIn Recruiter misclassification —
 * we don't repeat that pattern here.
 *
 * Always returns 202 to Graph so a transient Inngest hiccup never causes
 * the subscription to get marked unhealthy.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  // ── Graph subscription validation handshake ────────────────────
  // Graph hits the endpoint with ?validationToken=… on every subscription
  // create + renewal. We must echo the token verbatim as text/plain within
  // 10s or the subscription gets dropped.
  const url = new URL(req.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(decodeURIComponent(validationToken), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const receivedAt = new Date().toISOString();
  const notifications: any[] = Array.isArray(body?.value) ? body.value : [];

  if (!notifications.length) {
    // No notifications array — log and ack; Graph sometimes sends keepalives.
    console.log("outlook-webhook: empty notification batch", { keys: Object.keys(body ?? {}) });
    return new Response(JSON.stringify({ received: true, count: 0 }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let forwarded = 0;
  let failed = 0;
  for (const notification of notifications) {
    try {
      await sendInngestEvent("webhooks/microsoft.received", { notification, receivedAt });
      forwarded++;
    } catch (err: any) {
      failed++;
      console.error("outlook-webhook: Inngest forward failed", {
        subscriptionId: notification?.subscriptionId,
        error: err.message,
      });
    }
  }

  // 202 always — Graph treats non-2xx as delivery failure and will retry
  // aggressively. If Inngest forwarding failed we logged it; the Inngest
  // function dedupes by external_message_id so a manual replay is safe.
  return new Response(JSON.stringify({ received: true, count: notifications.length, forwarded, failed }), {
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
