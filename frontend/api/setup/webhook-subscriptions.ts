import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * Vercel serverless function to create/renew webhook subscriptions
 * for Microsoft Graph and RingCentral.
 *
 * POST /api/setup/webhook-subscriptions
 * Headers: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *
 * This creates Graph subscriptions for each user's mailbox + calendar,
 * and RingCentral webhook subscriptions for each user with RC credentials.
 *
 * Can also be called by the renew-webhook-subscriptions Trigger.dev task.
 */

const WEBHOOK_BASE_URL = "https://www.sullyrecruit.app";

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper — only service role key can call this
// ─────────────────────────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function getAppSettings(
  supabase: any,
  ...keys: string[]
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", keys);

  if (error) throw new Error(`Failed to read app_settings: ${error.message}`);

  const result: Record<string, string> = {};
  for (const row of data || []) {
    if (row.value) result[row.key] = row.value;
  }
  for (const key of keys) {
    if (!result[key]) throw new Error(`Missing app_setting: ${key}`);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph subscriptions
// ─────────────────────────────────────────────────────────────────────────────

async function getMicrosoftAccessToken(supabase: any): Promise<string> {
  const settings = await getAppSettings(
    supabase,
    "MICROSOFT_GRAPH_CLIENT_ID",
    "MICROSOFT_GRAPH_CLIENT_SECRET",
    "MICROSOFT_GRAPH_TENANT_ID",
  );

  const resp = await fetch(
    `https://login.microsoftonline.com/${settings.MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.MICROSOFT_GRAPH_CLIENT_ID,
        client_secret: settings.MICROSOFT_GRAPH_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  if (!resp.ok) throw new Error(`Microsoft token error: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

interface SubscriptionResult {
  service: string;
  user: string;
  resource: string;
  status: "created" | "renewed" | "error";
  subscriptionId?: string;
  expiresAt?: string;
  error?: string;
}

async function createGraphSubscriptions(supabase: any): Promise<SubscriptionResult[]> {
  const accessToken = await getMicrosoftAccessToken(supabase);
  const results: SubscriptionResult[] = [];

  // Get all user emails from profiles
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .not("email", "is", null);

  if (!profiles || profiles.length === 0) {
    return [{ service: "microsoft_graph", user: "all", resource: "none", status: "error", error: "No profiles with emails found" }];
  }

  // First, list existing subscriptions to avoid duplicates
  const existingResp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let existingSubscriptions: any[] = [];
  if (existingResp.ok) {
    const existingData = await existingResp.json();
    existingSubscriptions = existingData.value || [];
  }

  // Graph subscriptions expire: mail = 3 days max, calendar = 3 days max
  // Set to ~2 days so renewal task can refresh before expiry
  const expirationDateTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  for (const profile of profiles) {
    const email = profile.email;
    const userName = profile.full_name || email;

    // Subscribe to mail and calendar for each user
    const resources = [
      { resource: `users/${email}/messages`, changeType: "created", label: "mail" },
      { resource: `users/${email}/events`, changeType: "created,updated,deleted", label: "calendar" },
    ];

    for (const res of resources) {
      // Check if subscription already exists
      const existing = existingSubscriptions.find(
        (s: any) => s.resource === res.resource,
      );

      if (existing) {
        // Renew existing subscription
        try {
          const renewResp = await fetch(
            `https://graph.microsoft.com/v1.0/subscriptions/${existing.id}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expirationDateTime }),
            },
          );

          if (renewResp.ok) {
            const renewed = await renewResp.json();
            results.push({
              service: "microsoft_graph",
              user: userName,
              resource: res.label,
              status: "renewed",
              subscriptionId: existing.id,
              expiresAt: renewed.expirationDateTime,
            });
            continue;
          }
        } catch {
          // Fall through to create new
        }
      }

      // Create new subscription
      try {
        const createResp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            changeType: res.changeType,
            notificationUrl: `${WEBHOOK_BASE_URL}/api/webhooks/microsoft-graph`,
            resource: res.resource,
            expirationDateTime,
            clientState: "sullyrecruit_graph_webhook",
          }),
        });

        if (createResp.ok) {
          const sub = await createResp.json();
          results.push({
            service: "microsoft_graph",
            user: userName,
            resource: res.label,
            status: "created",
            subscriptionId: sub.id,
            expiresAt: sub.expirationDateTime,
          });
        } else {
          const errText = await createResp.text();
          results.push({
            service: "microsoft_graph",
            user: userName,
            resource: res.label,
            status: "error",
            error: errText,
          });
        }
      } catch (err: any) {
        results.push({
          service: "microsoft_graph",
          user: userName,
          resource: res.label,
          status: "error",
          error: err.message,
        });
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// RingCentral webhook subscriptions
// ─────────────────────────────────────────────────────────────────────────────

async function createRingCentralSubscriptions(supabase: any): Promise<SubscriptionResult[]> {
  const results: SubscriptionResult[] = [];

  // Get all users with active RingCentral integrations.
  // RC creds live in integration_accounts (provider='sms'), not user_integrations.
  const { data: integrations } = await supabase
    .from("integration_accounts")
    .select("owner_user_id, account_label, rc_jwt, metadata")
    .eq("provider", "sms")
    .eq("is_active", true)
    .not("rc_jwt", "is", null);

  if (!integrations || integrations.length === 0) {
    return [{ service: "ringcentral", user: "all", resource: "none", status: "error", error: "No RingCentral integrations found" }];
  }

  for (const integration of integrations) {
    const meta = integration.metadata ?? {};
    const serverUrl = meta.rc_server_url || "https://platform.ringcentral.com";
    const clientId = meta.rc_client_id;
    const clientSecret = meta.rc_client_secret;
    const jwt = integration.rc_jwt;

    // Look up user name
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", integration.owner_user_id)
      .maybeSingle();

    const userName = profile?.full_name || profile?.email || integration.account_label || integration.owner_user_id;

    if (!clientId || !clientSecret || !jwt) {
      results.push({
        service: "ringcentral",
        user: userName,
        resource: "auth",
        status: "error",
        error: "Missing rc_client_id/rc_client_secret in metadata or rc_jwt",
      });
      continue;
    }

    try {
      // Authenticate with JWT bearer flow
      const authResp = await fetch(`${serverUrl}/restapi/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
      });

      if (!authResp.ok) {
        const errText = await authResp.text();
        results.push({
          service: "ringcentral",
          user: userName,
          resource: "auth",
          status: "error",
          error: `Auth failed: ${errText}`,
        });
        continue;
      }

      const { access_token } = await authResp.json();

      // Check existing subscriptions
      const listResp = await fetch(
        `${serverUrl}/restapi/v1.0/subscription`,
        { headers: { Authorization: `Bearer ${access_token}` } },
      );

      let existingSubs: any[] = [];
      if (listResp.ok) {
        const listData = await listResp.json();
        existingSubs = listData.records || [];
      }

      // Find existing webhook subscription to our URL
      const existingSub = existingSubs.find(
        (s: any) =>
          s.deliveryMode?.transportType === "WebHook" &&
          s.deliveryMode?.address?.includes("sullyrecruit.app"),
      );

      if (existingSub && existingSub.status === "Active") {
        // Renew existing subscription
        const renewResp = await fetch(
          `${serverUrl}/restapi/v1.0/subscription/${existingSub.id}/renew`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${access_token}` },
          },
        );

        if (renewResp.ok) {
          const renewed = await renewResp.json();
          results.push({
            service: "ringcentral",
            user: userName,
            resource: "calls+sms+voicemail",
            status: "renewed",
            subscriptionId: existingSub.id,
            expiresAt: renewed.expirationTime,
          });
          continue;
        }
        // Fall through to create new if renew fails
      }

      // Create new subscription
      const rcWebhookToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
      const deliveryMode: Record<string, string> = {
        transportType: "WebHook",
        address: `${WEBHOOK_BASE_URL}/api/webhooks/ringcentral`,
      };
      if (rcWebhookToken) {
        deliveryMode.verificationToken = rcWebhookToken;
      }

      const createResp = await fetch(`${serverUrl}/restapi/v1.0/subscription`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventFilters: [
            "/restapi/v1.0/account/~/extension/~/telephony/sessions",
            "/restapi/v1.0/account/~/extension/~/message-store",
            "/restapi/v1.0/account/~/extension/~/voicemail",
          ],
          deliveryMode,
          expiresIn: 604800, // 7 days (max for RC)
        }),
      });

      if (createResp.ok) {
        const sub = await createResp.json();
        results.push({
          service: "ringcentral",
          user: userName,
          resource: "calls+sms+voicemail",
          status: "created",
          subscriptionId: sub.id,
          expiresAt: sub.expirationTime,
        });
      } else {
        const errText = await createResp.text();
        results.push({
          service: "ringcentral",
          user: userName,
          resource: "calls+sms+voicemail",
          status: "error",
          error: errText,
        });
      }
    } catch (err: any) {
      results.push({
        service: "ringcentral",
        user: userName,
        resource: "all",
        status: "error",
        error: err.message,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Simple auth — require service role key in Authorization header
  const authHeader = req.headers.authorization;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!authHeader || !serviceKey || authHeader !== `Bearer ${serviceKey}`) {
    return res.status(401).json({ error: "Unauthorized. Pass service role key as Bearer token." });
  }

  const supabase = getSupabase();
  const results: SubscriptionResult[] = [];

  // Optionally filter by service
  const service = req.body?.service; // "microsoft_graph", "ringcentral", or undefined for all

  try {
    if (!service || service === "microsoft_graph") {
      const graphResults = await createGraphSubscriptions(supabase);
      results.push(...graphResults);
    }

    if (!service || service === "ringcentral") {
      const rcResults = await createRingCentralSubscriptions(supabase);
      results.push(...rcResults);
    }

    const summary = {
      total: results.length,
      created: results.filter((r) => r.status === "created").length,
      renewed: results.filter((r) => r.status === "renewed").length,
      errors: results.filter((r) => r.status === "error").length,
    };

    return res.status(200).json({ summary, results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message, results });
  }
}
