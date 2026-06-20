import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID")!;
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET")!;
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const MICROSOFT_CLIENT_ID = Deno.env.get("MICROSOFT_CLIENT_ID")!;
const MICROSOFT_CLIENT_SECRET = Deno.env.get("MICROSOFT_CLIENT_SECRET")!;
const MICROSOFT_TENANT_ID = Deno.env.get("MICROSOFT_TENANT_ID") || "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") || "";
const NOTIFICATION_URL = `${SUPABASE_URL}/functions/v1/outlook-webhook`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getGraphEmails(): Set<string> {
  return new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

async function refreshToken(account: any): Promise<string> {
  const email = (account.email_address ?? "").toLowerCase().trim();
  const useGraph = getGraphEmails().has(email);
  const clientId = useGraph ? MICROSOFT_GRAPH_CLIENT_ID : MICROSOFT_CLIENT_ID;
  const clientSecret = useGraph ? MICROSOFT_GRAPH_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET;
  const tenantId = useGraph ? MICROSOFT_GRAPH_TENANT_ID : MICROSOFT_TENANT_ID;

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
        scope: "offline_access Mail.Read Mail.Send User.Read openid profile",
      }),
    }
  );
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh failed for ${email}: ${data?.error_description}`);

  const expiresAt = new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString();
  await supabase.from("integration_accounts").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? account.refresh_token,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);

  return data.access_token;
}

async function getMicrosoftUserId(token: string): Promise<string | null> {
  const resp = await fetch("https://graph.microsoft.com/v1.0/me?$select=id", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  return data.id ?? null;
}

async function registerSubscription(account: any): Promise<{ ok: boolean; subscriptionId?: string; error?: string }> {
  try {
    // Get fresh token
    let token = account.access_token;
    if (!token || !account.token_expires_at || new Date(account.token_expires_at).getTime() - Date.now() < 300000) {
      token = await refreshToken(account);
    }

    // Fetch + save microsoft_user_id if missing (needed by outlook-webhook to fetch messages)
    let msUserId = account.microsoft_user_id;
    if (!msUserId) {
      msUserId = await getMicrosoftUserId(token);
      if (msUserId) {
        await supabase.from("integration_accounts").update({
          microsoft_user_id: msUserId,
          updated_at: new Date().toISOString(),
        }).eq("id", account.id);
        console.log(`[register-graph-subscriptions] saved microsoft_user_id=${msUserId} for ${account.email_address}`);
      }
    }

    // Delete old subscription if we have one stored
    const oldSubId = account.microsoft_subscription_id ?? account.webhook_subscription_id;
    if (oldSubId) {
      await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${oldSubId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      ).catch(() => {});
    }

    // Create new subscription — 3 days max
    const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const resp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: NOTIFICATION_URL,
        resource: "me/mailFolders('Inbox')/messages",
        expirationDateTime: expiryDate,
        clientState: account.id,
      }),
    });

    const data: any = await resp.json();
    if (!resp.ok) {
      console.error(`[register-graph-subscriptions] failed for ${account.email_address}:`, JSON.stringify(data));
      return { ok: false, error: `Graph ${resp.status}: ${data?.error?.message ?? JSON.stringify(data)}` };
    }

    const subscriptionId = data.id as string;

    // Write to BOTH columns so outlook-webhook can find it regardless of which column it checks
    await supabase.from("integration_accounts").update({
      microsoft_subscription_id: subscriptionId,
      webhook_subscription_id: subscriptionId,
      updated_at: new Date().toISOString(),
    }).eq("id", account.id);

    // Also upsert into graph_subscriptions table for tracking
    await supabase.from("graph_subscriptions").upsert({
      user_id: account.owner_user_id,
      subscription_id: subscriptionId,
      email_address: account.email_address,
      expires_at: expiryDate,
      created_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    console.log(`[register-graph-subscriptions] ✅ ${account.email_address} → ${subscriptionId} expires ${expiryDate}`);
    return { ok: true, subscriptionId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const graphEmails = getGraphEmails();

  // Fetch all active Microsoft email accounts that have a refresh token
  const { data: accounts, error } = await supabase
    .from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, microsoft_subscription_id, webhook_subscription_id, microsoft_user_id, owner_user_id")
    .eq("provider", "email")
    .eq("auth_provider", "microsoft")
    .eq("is_active", true)
    .not("refresh_token", "is", null);

  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const account of accounts ?? []) {
    const email = (account.email_address ?? "").toLowerCase().trim();
    // Only register accounts that have valid OAuth (in GRAPH list or have a refresh token)
    // Skip house account with no token
    if (!graphEmails.has(email) && !account.refresh_token) continue;

    const result = await registerSubscription(account);
    results.push({ email: account.email_address, ...result });
  }

  return json({ ok: true, registered: results.filter((r: any) => r.ok).length, results });
});
