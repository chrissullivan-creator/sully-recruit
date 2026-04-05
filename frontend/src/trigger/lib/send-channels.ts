import { logger } from "@trigger.dev/sdk/v3";
import { getMicrosoftGraphCredentials } from "./supabase";

/**
 * Channel send helpers — routes to the correct per-user account.
 *
 * Each recruiter has their own accounts:
 *   - Email: Microsoft Graph mailbox (Chris, Nancy, Ashley)
 *   - SMS: RingCentral number (Chris, Nancy — Ashley has none)
 *   - LinkedIn: Unipile account (Chris, Nancy, Ashley)
 *
 * The enrolled_by userId is used to look up the correct account
 * from user_integrations (RingCentral) and integration_accounts (Unipile).
 * Email sender is resolved from the profiles table.
 *
 * Org-level secrets (Microsoft Graph app creds, etc.) are read from
 * the app_settings table in Supabase — NOT from env vars.
 */

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL via Microsoft Graph — per-user mailbox
// ─────────────────────────────────────────────────────────────────────────────

async function getMicrosoftAccessToken(): Promise<string> {
  const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

  const resp = await fetch(
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

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft token error: ${errText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Resolve the sender email address for a given user.
 * Looks up the user's email from the profiles table.
 */
async function resolveSenderEmail(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.email) return profile.email;

  throw new Error(`No email found in profiles table for user ${userId}. Ensure the user has an email set.`);
}

export async function sendEmail(
  supabase: any,
  to: string,
  subject: string | undefined,
  body: string,
  userId: string,
): Promise<{ messageId: string; sender: string }> {
  const accessToken = await getMicrosoftAccessToken();
  const fromEmail = await resolveSenderEmail(supabase, userId);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: subject || "",
          body: { contentType: "HTML", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Microsoft Graph sendMail error (${fromEmail}): ${error}`);
  }

  const messageId = `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info("Email sent via Graph", { from: fromEmail, to });
  return { messageId, sender: fromEmail };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS via RingCentral — per-user credentials from user_integrations
// ─────────────────────────────────────────────────────────────────────────────

interface RingCentralConfig {
  client_id: string;
  client_secret: string;
  jwt_token: string;
  server_url: string;
  phone_number: string;
}

/**
 * Look up the RingCentral config for a specific user from user_integrations.
 * Chris and Nancy each have their own RC number.
 * Ashley has NO RingCentral — will throw if attempted.
 */
async function getRingCentralConfig(supabase: any, userId: string): Promise<RingCentralConfig> {
  const { data, error } = await supabase
    .from("user_integrations")
    .select("config")
    .eq("user_id", userId)
    .eq("integration_type", "ringcentral")
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`No RingCentral integration for user ${userId}. Ashley has no RingCentral — don't route SMS to her.`);
  }

  const config = data.config as RingCentralConfig;
  if (!config.client_id || !config.client_secret || !config.jwt_token) {
    throw new Error(`RingCentral credentials incomplete for user ${userId}`);
  }

  return config;
}

export async function sendSms(
  supabase: any,
  to: string,
  body: string,
  userId: string,
): Promise<{ id: string; sender: string }> {
  const config = await getRingCentralConfig(supabase, userId);
  const serverUrl = config.server_url || "https://platform.ringcentral.com";

  // Get access token using JWT bearer flow
  const authResponse = await fetch(`${serverUrl}/restapi/oauth/token`, {
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

  if (!authResponse.ok) {
    const errText = await authResponse.text();
    throw new Error(`RingCentral auth failed for user ${userId}: ${errText}`);
  }

  const { access_token } = await authResponse.json();

  const smsResponse = await fetch(
    `${serverUrl}/restapi/v1.0/account/~/extension/~/sms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [{ phoneNumber: to }],
        from: { phoneNumber: config.phone_number },
        text: body,
      }),
    },
  );

  if (!smsResponse.ok) {
    const error = await smsResponse.text();
    throw new Error(`RingCentral SMS error: ${error}`);
  }

  const smsData = await smsResponse.json();
  logger.info("SMS sent via RingCentral", { from: config.phone_number, to });
  return { id: smsData.id, sender: config.phone_number };
}

// ─────────────────────────────────────────────────────────────────────────────
// LINKEDIN via Unipile — per-user account from integration_accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the Unipile API key for a specific user.
 * Checks integration_accounts by owner_user_id first, then falls back to
 * explicit accountId, then auto-discovers any active account.
 */
async function getUnipileApiKey(
  supabase: any,
  userId?: string,
  accountId?: string,
): Promise<{ apiKey: string; accountId: string }> {
  // 1. Try explicit accountId
  if (accountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, access_token")
      .eq("id", accountId)
      .single();
    if (account?.access_token) {
      return { apiKey: account.access_token, accountId: account.id };
    }
  }

  // 2. Try by owner_user_id (Chris/Nancy/Ashley's specific LinkedIn account)
  if (userId) {
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, access_token")
      .eq("owner_user_id", userId)
      .or("account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .limit(1);

    if (accounts?.[0]?.access_token) {
      return { apiKey: accounts[0].access_token, accountId: accounts[0].id };
    }
  }

  // 3. Auto-discover any active LinkedIn account
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, access_token")
    .or("account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
    .eq("is_active", true)
    .limit(1);

  if (accounts?.[0]?.access_token) {
    return { apiKey: accounts[0].access_token, accountId: accounts[0].id };
  }

  throw new Error("No active LinkedIn/Unipile account found");
}

export async function sendLinkedIn(
  supabase: any,
  to: string,
  body: string,
  userId?: string,
  accountId?: string,
  stepChannel?: string,
): Promise<{ message_id: string; conversation_id: string }> {
  const { apiKey, accountId: resolvedAccountId } = await getUnipileApiKey(supabase, userId, accountId);
  const baseUrl = "https://api.unipile.com:13111/api/v1";

  // Resolve LinkedIn URL to provider_id if needed
  let providerId = to;
  if (to.includes("linkedin.com/")) {
    const match = to.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) {
      const lookupResp = await fetch(`${baseUrl}/users/${encodeURIComponent(match[1])}`, {
        headers: { Authorization: `Bearer ${apiKey}`, "X-UNIPILE-CLIENT": "sully-recruit" },
      });
      if (lookupResp.ok) {
        const userData = await lookupResp.json();
        providerId = userData.provider_id || userData.id || match[1];
      } else {
        throw new Error(`Could not resolve LinkedIn profile: ${match[1]}`);
      }
    }
  }

  // Determine message type
  const isInMailChannel =
    stepChannel === "sales_nav_inmail" ||
    stepChannel === "recruiter_inmail" ||
    stepChannel === "sales_nav" ||
    stepChannel === "linkedin_recruiter";
  const isConnectionRequest = stepChannel === "linkedin_connection";

  // Connection requests use a different Unipile endpoint
  if (isConnectionRequest) {
    const invitePayload: any = {
      provider_id: providerId,
      account_id: resolvedAccountId,
      message: body,
    };

    const response = await fetch(`${baseUrl}/users/invite`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-UNIPILE-CLIENT": "sully-recruit",
      },
      body: JSON.stringify(invitePayload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Unipile invite error: ${error}`);
    }

    const data = await response.json();
    return { message_id: data.id || `invite_${Date.now()}`, conversation_id: data.conversation_id || "" };
  }

  // Regular messages and InMails
  const sendPayload: any = { provider_id: providerId, text: body };
  if (isInMailChannel) sendPayload.message_type = "INMAIL";

  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-UNIPILE-CLIENT": "sully-recruit",
    },
    body: JSON.stringify(sendPayload),
  });

  if (!response.ok) {
    const error = await response.text();
    if (isInMailChannel && response.status === 422) {
      throw new Error(`InMail ${response.status}: ${error}`);
    }
    throw new Error(`Unipile send error: ${error}`);
  }

  const data = await response.json();
  return { message_id: data.id, conversation_id: data.conversation_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE RECIPIENT ADDRESS
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveRecipient(
  supabase: any,
  channel: string,
  entityId: string,
  entityType: "candidate" | "contact",
  userId?: string,
  accountId?: string,
): Promise<{ to: string; conversationId: string | null }> {
  const table = entityType === "candidate" ? "candidates" : "contacts";

  if (channel === "email") {
    const { data: entity } = await supabase.from(table).select("email").eq("id", entityId).single();
    if (!entity?.email) throw new Error(`No email for ${entityType} ${entityId}`);
    return { to: entity.email, conversationId: null };
  }

  if (channel === "sms") {
    const { data: entity } = await supabase.from(table).select("phone").eq("id", entityId).single();
    if (!entity?.phone) throw new Error(`No phone for ${entityType} ${entityId}`);
    return { to: entity.phone, conversationId: null };
  }

  // LinkedIn channels — resolve Unipile provider_id
  if (entityType === "candidate") {
    const { data: cachedChannel } = await supabase
      .from("candidate_channels")
      .select("provider_id, unipile_id, external_conversation_id")
      .eq("candidate_id", entityId)
      .eq("channel", "linkedin")
      .maybeSingle();

    if (cachedChannel?.provider_id || cachedChannel?.unipile_id) {
      return {
        to: cachedChannel.provider_id || cachedChannel.unipile_id,
        conversationId: cachedChannel.external_conversation_id || null,
      };
    }
  }

  // Resolve from LinkedIn URL
  const { data: entity } = await supabase.from(table).select("linkedin_url").eq("id", entityId).single();
  if (!entity?.linkedin_url) throw new Error(`No LinkedIn URL for ${entityType} ${entityId}`);

  const match = entity.linkedin_url.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!match) throw new Error(`Invalid LinkedIn URL: ${entity.linkedin_url}`);

  // Get Unipile API key for this user
  const { apiKey } = await getUnipileApiKey(supabase, userId, accountId);
  const baseUrl = "https://api.unipile.com:13111/api/v1";

  const lookupResp = await fetch(`${baseUrl}/users/${encodeURIComponent(match[1])}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-UNIPILE-CLIENT": "sully-recruit" },
  });

  if (!lookupResp.ok) throw new Error(`Unipile lookup failed for ${match[1]}: ${lookupResp.status}`);

  const userData = await lookupResp.json();
  const resolvedId = userData.provider_id || userData.id;

  // Cache resolved ID
  if (entityType === "candidate" && resolvedId) {
    await supabase.from("candidate_channels").upsert(
      {
        candidate_id: entityId,
        channel: "linkedin",
        provider_id: resolvedId,
        unipile_id: resolvedId,
        is_connected: true,
      },
      { onConflict: "candidate_id,channel" },
    );
    logger.info("Cached Unipile ID", { entityId, resolvedId });
  }

  return { to: resolvedId, conversationId: null };
}
