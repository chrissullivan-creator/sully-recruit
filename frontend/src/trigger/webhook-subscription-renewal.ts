import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getMicrosoftGraphCredentials } from "./lib/supabase";

const WEBHOOK_BASE_URL = "https://www.sullyrecruit.app";

/**
 * Scheduled task: renew Microsoft Graph and RingCentral webhook subscriptions.
 *
 * Graph subscriptions expire every 3 days max, RC every 7 days.
 * This runs daily to keep them alive.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: renew-webhook-subscriptions
 *   Cron: 0 6 * * * (daily at 6 AM UTC)
 */
export const renewWebhookSubscriptions = schedules.task({
  id: "renew-webhook-subscriptions",
  run: async () => {
    const supabase = getSupabaseAdmin();
    const results: { service: string; user: string; status: string; error?: string }[] = [];

    // ── Microsoft Graph ──────────────────────────────────────────────────
    try {
      const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

      const tokenResp = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
          }),
        },
      );

      if (!tokenResp.ok) throw new Error(`Token error: ${await tokenResp.text()}`);
      const { access_token } = await tokenResp.json();

      // List all existing subscriptions
      const listResp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (listResp.ok) {
        const { value: subscriptions } = await listResp.json();
        const expirationDateTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

        for (const sub of subscriptions || []) {
          try {
            const renewResp = await fetch(
              `https://graph.microsoft.com/v1.0/subscriptions/${sub.id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${access_token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ expirationDateTime }),
              },
            );

            if (renewResp.ok) {
              results.push({ service: "graph", user: sub.resource, status: "renewed" });
              logger.info("Renewed Graph subscription", { id: sub.id, resource: sub.resource });
            } else {
              const errText = await renewResp.text();
              results.push({ service: "graph", user: sub.resource, status: "error", error: errText });
              logger.warn("Failed to renew Graph subscription", { id: sub.id, error: errText });
            }
          } catch (err: any) {
            results.push({ service: "graph", user: sub.resource, status: "error", error: err.message });
          }
        }

        if (!subscriptions || subscriptions.length === 0) {
          logger.warn("No Graph subscriptions found — run /api/setup/webhook-subscriptions to create them");
          results.push({ service: "graph", user: "none", status: "error", error: "No subscriptions found" });
        }
      }
    } catch (err: any) {
      logger.error("Graph renewal failed", { error: err.message });
      results.push({ service: "graph", user: "all", status: "error", error: err.message });
    }

    // ── RingCentral ──────────────────────────────────────────────────────
    try {
      const { data: integrations } = await supabase
        .from("user_integrations")
        .select("user_id, config")
        .eq("integration_type", "ringcentral")
        .eq("is_active", true);

      for (const integration of integrations || []) {
        const config = integration.config as any;
        const serverUrl = config.server_url || "https://platform.ringcentral.com";

        try {
          // Authenticate
          const authResp = await fetch(`${serverUrl}/restapi/oauth/token`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion: config.jwt_token,
            }),
          });

          if (!authResp.ok) {
            results.push({ service: "ringcentral", user: integration.user_id, status: "error", error: "Auth failed" });
            continue;
          }

          const { access_token } = await authResp.json();

          // List subscriptions
          const listResp = await fetch(`${serverUrl}/restapi/v1.0/subscription`, {
            headers: { Authorization: `Bearer ${access_token}` },
          });

          if (!listResp.ok) {
            results.push({ service: "ringcentral", user: integration.user_id, status: "error", error: "List failed" });
            continue;
          }

          const { records } = await listResp.json();
          const ourSub = (records || []).find(
            (s: any) =>
              s.deliveryMode?.transportType === "WebHook" &&
              s.deliveryMode?.address?.includes("sullyrecruit.app"),
          );

          if (ourSub) {
            const renewResp = await fetch(
              `${serverUrl}/restapi/v1.0/subscription/${ourSub.id}/renew`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${access_token}` },
              },
            );

            if (renewResp.ok) {
              results.push({ service: "ringcentral", user: integration.user_id, status: "renewed" });
              logger.info("Renewed RingCentral subscription", { userId: integration.user_id });
            } else {
              results.push({ service: "ringcentral", user: integration.user_id, status: "error", error: "Renew failed" });
            }
          } else {
            // No subscription found — create one
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
                deliveryMode: {
                  transportType: "WebHook",
                  address: `${WEBHOOK_BASE_URL}/api/webhooks/ringcentral`,
                },
                expiresIn: 604800,
              }),
            });

            if (createResp.ok) {
              results.push({ service: "ringcentral", user: integration.user_id, status: "created" });
              logger.info("Created RingCentral subscription", { userId: integration.user_id });
            } else {
              const errText = await createResp.text();
              results.push({ service: "ringcentral", user: integration.user_id, status: "error", error: errText });
            }
          }
        } catch (err: any) {
          results.push({ service: "ringcentral", user: integration.user_id, status: "error", error: err.message });
        }
      }
    } catch (err: any) {
      logger.error("RingCentral renewal failed", { error: err.message });
      results.push({ service: "ringcentral", user: "all", status: "error", error: err.message });
    }

    logger.info("Webhook subscription renewal complete", { results });
    return { results };
  },
});
