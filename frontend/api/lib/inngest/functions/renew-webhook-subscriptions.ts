import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getMicrosoftGraphCredentials,
} from "../../../../src/server-lib/supabase.js";
import { fetchWithRetry } from "../../../../src/server-lib/fetch-retry.js";

const WEBHOOK_BASE_URL = "https://www.sullyrecruit.app";

/**
 * Renew Microsoft Graph + RingCentral webhook subscriptions before they
 * expire. Graph subs cap at 3 days, RC at 7 — daily renewal keeps both
 * comfortably alive.
 *
 * On RC, if no active subscription is found, this also creates one
 * pointing at /api/webhooks/ringcentral so a fresh tenant doesn't need
 * a manual setup step.
 *
 * Daily at 06:00 UTC. Ported from
 * `src/trigger/webhook-subscription-renewal.ts` — Inngest is the only
 * scheduler now. All external calls go through fetchWithRetry so a
 * transient 429/5xx doesn't silently skip renewal (which would let
 * webhooks lapse until the next day).
 */
export const renewWebhookSubscriptions = inngest.createFunction(
  { id: "renew-webhook-subscriptions", name: "Renew Graph + RingCentral webhook subscriptions (Inngest)" },
  { cron: "0 6 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const results: { service: string; user: string; status: string; error?: string }[] = [];

    // ── Microsoft Graph ──────────────────────────────────────────────────
    try {
      const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

      const tokenResp = await fetchWithRetry(
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
        { label: "graph-token" },
      );

      if (!tokenResp.ok) throw new Error(`Token error: ${await tokenResp.text()}`);
      const { access_token } = await tokenResp.json();

      // List existing subs so we renew what's live and only create what's missing.
      const listResp = await fetchWithRetry(
        "https://graph.microsoft.com/v1.0/subscriptions",
        { headers: { Authorization: `Bearer ${access_token}` } },
        { label: "graph-subs-list" },
      );
      const existing: any[] = listResp.ok ? ((await listResp.json()).value || []) : [];

      // Self-heal. Graph subscriptions expire every ~3 days; the previous
      // version only PATCHed whatever already existed and merely *warned*
      // when the list was empty — so once every sub lapsed, nothing ever
      // recreated them and inbound mail + calendar silently stopped flowing.
      // Now we ensure every team mailbox has a live mail + calendar sub,
      // mirroring the create-or-renew in /api/setup/webhook-subscriptions
      // (keep the two resource shapes in sync if either changes).
      const { data: profiles } = await supabase
        .from("profiles")
        .select("email, full_name")
        .not("email", "is", null);

      const expirationDateTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

      for (const profile of profiles || []) {
        const email = profile.email;
        const userName = profile.full_name || email;
        const resources = [
          { resource: `users/${email}/messages`, changeType: "created", label: "mail" },
          { resource: `users/${email}/events`, changeType: "created,updated,deleted", label: "calendar" },
        ];

        for (const res of resources) {
          const match = existing.find((s: any) => s.resource === res.resource);
          try {
            if (match) {
              const renewResp = await fetchWithRetry(
                `https://graph.microsoft.com/v1.0/subscriptions/${match.id}`,
                {
                  method: "PATCH",
                  headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ expirationDateTime }),
                },
                { label: "graph-sub-renew" },
              );
              if (renewResp.ok) {
                results.push({ service: "graph", user: `${userName} (${res.label})`, status: "renewed" });
                logger.info("Renewed Graph subscription", { id: match.id, resource: res.resource });
                continue;
              }
              logger.warn("Graph renew failed — recreating", { resource: res.resource, status: renewResp.status });
            }

            const createResp = await fetchWithRetry(
              "https://graph.microsoft.com/v1.0/subscriptions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${access_token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  changeType: res.changeType,
                  notificationUrl: `${WEBHOOK_BASE_URL}/api/webhooks/microsoft-graph`,
                  resource: res.resource,
                  expirationDateTime,
                  clientState: "sullyrecruit_graph_webhook",
                }),
              },
              { label: "graph-sub-create" },
            );

            if (createResp.ok) {
              const sub = await createResp.json();
              results.push({ service: "graph", user: `${userName} (${res.label})`, status: match ? "recreated" : "created" });
              logger.info("Created Graph subscription", { id: sub.id, resource: res.resource });
            } else {
              const errText = await createResp.text();
              results.push({ service: "graph", user: `${userName} (${res.label})`, status: "error", error: errText });
              logger.warn("Failed to create Graph subscription", { resource: res.resource, error: errText });
            }
          } catch (err: any) {
            results.push({ service: "graph", user: `${userName} (${res.label})`, status: "error", error: err.message });
          }
        }
      }
    } catch (err: any) {
      logger.error("Graph renewal failed", { error: err.message });
      results.push({ service: "graph", user: "all", status: "error", error: err.message });
    }

    // ── RingCentral ──────────────────────────────────────────────────────
    try {
      const { data: integrations } = await supabase
        .from("integration_accounts")
        .select("owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
        .eq("provider", "sms")
        .eq("is_active", true)
        .not("rc_jwt", "is", null);

      const rcWebhookToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN;

      for (const integration of integrations || []) {
        const meta = (integration.metadata as any) ?? {};
        const userId = integration.owner_user_id;
        const userLabel = integration.account_label || userId;
        const serverUrl = meta.rc_server_url || "https://platform.ringcentral.com";
        const clientId = meta.rc_client_id;
        const clientSecret = meta.rc_client_secret;
        const jwt = integration.rc_jwt;

        if (!clientId || !clientSecret || !jwt) {
          results.push({
            service: "ringcentral",
            user: userLabel,
            status: "error",
            error: "Missing rc_client_id/secret or rc_jwt",
          });
          continue;
        }

        try {
          const authResp = await fetchWithRetry(
            `${serverUrl}/restapi/oauth/token`,
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: jwt,
              }),
            },
            { label: "rc-token" },
          );

          if (!authResp.ok) {
            results.push({
              service: "ringcentral",
              user: userLabel,
              status: "error",
              error: `Auth failed: ${await authResp.text()}`,
            });
            continue;
          }

          const { access_token } = await authResp.json();

          const listResp = await fetchWithRetry(
            `${serverUrl}/restapi/v1.0/subscription`,
            { headers: { Authorization: `Bearer ${access_token}` } },
            { label: "rc-subs-list" },
          );

          if (!listResp.ok) {
            results.push({ service: "ringcentral", user: userLabel, status: "error", error: "List failed" });
            continue;
          }

          const { records } = await listResp.json();
          const ourSub = (records || []).find(
            (s: any) =>
              s.deliveryMode?.transportType === "WebHook" &&
              s.deliveryMode?.address?.includes("sullyrecruit.app") &&
              s.status === "Active",
          );

          if (ourSub) {
            const renewResp = await fetchWithRetry(
              `${serverUrl}/restapi/v1.0/subscription/${ourSub.id}/renew`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${access_token}` },
              },
              { label: "rc-sub-renew" },
            );

            if (renewResp.ok) {
              results.push({ service: "ringcentral", user: userLabel, status: "renewed" });
              logger.info("Renewed RingCentral subscription", { userId, subId: ourSub.id });
              continue;
            }
            logger.warn("RC renew failed, creating new subscription", { userId, status: renewResp.status });
          }

          // No active subscription found — create one
          const deliveryMode: Record<string, string> = {
            transportType: "WebHook",
            address: `${WEBHOOK_BASE_URL}/api/webhooks/ringcentral`,
          };
          if (rcWebhookToken) deliveryMode.verificationToken = rcWebhookToken;

          const createResp = await fetchWithRetry(
            `${serverUrl}/restapi/v1.0/subscription`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                eventFilters: [
                  // Account-level telephony so calls on EVERY extension fire a
                  // webhook. The connected JWT is the account-owner extension
                  // (which places no calls), so a per-extension `extension/~`
                  // filter would miss the reps' calls — the same scope bug we
                  // fixed in poll-rc-calls. message-store + voicemail have no
                  // account-level filter, so they stay scoped to the
                  // authenticated extension (SMS/voicemail real-time for other
                  // reps would need per-extension subs — not the priority).
                  "/restapi/v1.0/account/~/telephony/sessions",
                  "/restapi/v1.0/account/~/extension/~/message-store",
                  "/restapi/v1.0/account/~/extension/~/voicemail",
                ],
                deliveryMode,
                expiresIn: 604800,
              }),
            },
            { label: "rc-sub-create" },
          );

          if (createResp.ok) {
            results.push({ service: "ringcentral", user: userLabel, status: "created" });
            logger.info("Created RingCentral subscription", { userId });
          } else {
            const errText = await createResp.text();
            results.push({ service: "ringcentral", user: userLabel, status: "error", error: errText });
          }
        } catch (err: any) {
          results.push({ service: "ringcentral", user: userLabel, status: "error", error: err.message });
        }
      }
    } catch (err: any) {
      logger.error("RingCentral renewal failed", { error: err.message });
      results.push({ service: "ringcentral", user: "all", status: "error", error: err.message });
    }

    logger.info("Webhook subscription renewal complete", { results });
    return { results };
  },
);
