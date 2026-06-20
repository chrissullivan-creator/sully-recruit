import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RC_SERVER = "https://platform.ringcentral.com";
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/ringcentral-webhook`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function getToken(clientId: string, clientSecret: string, jwt: string): Promise<string> {
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function listSubscriptions(token: string): Promise<any[]> {
  const res = await fetch(`${RC_SERVER}/restapi/v1.0/subscription`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return (await res.json()).records ?? [];
}

async function deleteSubscription(token: string, id: string) {
  await fetch(`${RC_SERVER}/restapi/v1.0/subscription/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function createSubscription(token: string, filters: string[]): Promise<any> {
  const res = await fetch(`${RC_SERVER}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: filters,
      deliveryMode: {
        transportType: "WebHook",
        address: WEBHOOK_URL,
      },
      expiresIn: 2592000,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Create ${res.status}: ${text}`);
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const clientSecret = body.client_secret;
    if (!clientSecret) return respond({ error: "client_secret required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, rc_jwt, metadata")
      .eq("provider", "sms")
      .eq("is_active", true)
      .not("rc_jwt", "is", null);

    const acct = (accounts ?? []).find((a: any) => a.metadata?.rc_client_id);
    if (!acct?.rc_jwt) return respond({ error: "No SMS account with rc_client_id found" }, 404);

    const clientId = acct.metadata.rc_client_id;
    const token = await getToken(clientId, clientSecret, acct.rc_jwt);

    // Delete all existing subscriptions to our webhook
    const existing = await listSubscriptions(token);
    console.log(`[register-rc-webhook] found ${existing.length} existing subscriptions`);
    for (const sub of existing) {
      if (String(sub.deliveryMode?.address ?? "").includes("ringcentral-webhook")) {
        console.log(`[register-rc-webhook] deleting ${sub.id} filters=${JSON.stringify(sub.eventFilters)}`);
        await deleteSubscription(token, sub.id);
      }
    }

    // Create SMS subscription
    const smsSub = await createSubscription(token, [
      "/restapi/v1.0/account/~/extension/~/message-store",
    ]);
    console.log(`[register-rc-webhook] SMS sub created: ${smsSub.id}`);

    // Create telephony/call subscription separately
    // RC requires this as a separate subscription in some configurations
    let callSub: any = null;
    try {
      callSub = await createSubscription(token, [
        "/restapi/v1.0/account/~/telephony/sessions",
      ]);
      console.log(`[register-rc-webhook] Call sub created: ${callSub.id}`);
    } catch (e: any) {
      console.warn(`[register-rc-webhook] Call sub failed (may need RingSense permission): ${e.message}`);
    }

    // Store subscription IDs
    await supabase.from("integration_accounts").update({
      webhook_subscription_id: smsSub.id,
      metadata: {
        ...acct.metadata,
        rc_client_secret: clientSecret,
        call_subscription_id: callSub?.id ?? null,
      },
      updated_at: new Date().toISOString(),
    }).eq("id", acct.id);

    return respond({
      success: true,
      sms_subscription: { id: smsSub.id, filters: smsSub.eventFilters, expires: smsSub.expirationTime },
      call_subscription: callSub ? { id: callSub.id, filters: callSub.eventFilters, expires: callSub.expirationTime } : null,
      webhook_url: WEBHOOK_URL,
    });

  } catch (err: any) {
    console.error("[register-rc-webhook] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
