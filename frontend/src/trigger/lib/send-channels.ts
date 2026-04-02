import { logger } from "@trigger.dev/sdk/v3";

/**
 * Channel send helpers extracted from process-sequence-emails edge function.
 * Used by the sequence-step Trigger.dev task.
 *
 * Email: Microsoft Graph (emeraldrecruit.com tenant)
 * SMS: RingCentral
 * LinkedIn: Unipile
 */

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL via Microsoft Graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a client_credentials access token for the emeraldrecruit.com tenant.
 * Requires MICROSOFT_GRAPH_CLIENT_ID, MICROSOFT_GRAPH_CLIENT_SECRET,
 * MICROSOFT_GRAPH_TENANT_ID env vars.
 */
async function getMicrosoftAccessToken(): Promise<string> {
  const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;
  const tenantId = process.env.MICROSOFT_GRAPH_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error("Microsoft Graph credentials not configured (CLIENT_ID, CLIENT_SECRET, TENANT_ID)");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft token error: ${errText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

export async function sendEmail(
  to: string,
  subject: string | undefined,
  body: string,
  senderUserId?: string,
): Promise<{ messageId: string; sender: string }> {
  const accessToken = await getMicrosoftAccessToken();

  // Default sender — use the enrolled_by user's email or fall back to configured sender
  // Graph sendMail requires the sender's mailbox userId or userPrincipalName
  const fromEmail = senderUserId || process.env.MICROSOFT_GRAPH_SENDER_EMAIL || "";
  if (!fromEmail) {
    throw new Error(
      "No sender configured. Set MICROSOFT_GRAPH_SENDER_EMAIL or pass senderUserId.",
    );
  }

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
          body: {
            contentType: "HTML",
            content: body,
          },
          toRecipients: [
            {
              emailAddress: { address: to },
            },
          ],
        },
        saveToSentItems: true,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Microsoft Graph sendMail error: ${error}`);
  }

  // Graph sendMail returns 202 with no body on success
  // Generate a message ID from the timestamp since Graph doesn't return one synchronously
  const messageId = `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return { messageId, sender: fromEmail };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS via RingCentral
// ─────────────────────────────────────────────────────────────────────────────
export async function sendSms(
  to: string,
  body: string,
): Promise<{ id: string; sender: string }> {
  const clientId = process.env.RINGCENTRAL_CLIENT_ID;
  const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET;
  const jwtToken = process.env.RINGCENTRAL_JWT_TOKEN;
  const phoneNumber = process.env.RINGCENTRAL_PHONE_NUMBER;

  if (!clientId || !clientSecret || !jwtToken || !phoneNumber) {
    throw new Error("RingCentral not configured");
  }

  // Get access token using JWT bearer flow
  const authResponse = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: phoneNumber,
      password: jwtToken,
      extension: "",
    }),
  });

  if (!authResponse.ok) {
    throw new Error("RingCentral auth failed");
  }

  const authData = await authResponse.json();

  const smsResponse = await fetch(
    "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [{ phoneNumber: to }],
        from: { phoneNumber },
        text: body,
      }),
    },
  );

  if (!smsResponse.ok) {
    const error = await smsResponse.text();
    throw new Error(`RingCentral SMS error: ${error}`);
  }

  const smsData = await smsResponse.json();
  return { id: smsData.id, sender: phoneNumber };
}

// ─────────────────────────────────────────────────────────────────────────────
// LINKEDIN via Unipile
// ─────────────────────────────────────────────────────────────────────────────
export async function sendLinkedIn(
  supabase: any,
  to: string,
  body: string,
  accountId?: string,
  stepChannel?: string,
): Promise<{ message_id: string; conversation_id: string }> {
  let apiKey: string | null = null;

  if (accountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("provider_config")
      .eq("id", accountId)
      .single();
    apiKey = account?.provider_config?.unipile_api_key;
  }

  if (!apiKey) {
    // Auto-discover any active LinkedIn account
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, provider_config")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .limit(1);

    if (accounts?.[0]?.provider_config?.unipile_api_key) {
      apiKey = accounts[0].provider_config.unipile_api_key;
    }
  }

  if (!apiKey) {
    throw new Error("No active LinkedIn/Unipile account found");
  }

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

  const sendPayload: any = {
    provider_id: providerId,
    text: body,
  };
  if (isInMailChannel) sendPayload.message_type = "INMAIL";
  if (isConnectionRequest) sendPayload.message_type = "CONNECTION_REQUEST";

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
  entityType: "candidate" | "contact" | "prospect",
  accountId?: string,
): Promise<{ to: string; conversationId: string | null }> {
  const table = entityType === "candidate" ? "candidates" : entityType === "contact" ? "contacts" : "prospects";

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

  // Get Unipile API key
  let apiKey: string | null = null;
  if (accountId) {
    const { data: acct } = await supabase.from("integration_accounts").select("provider_config").eq("id", accountId).single();
    apiKey = acct?.provider_config?.unipile_api_key;
  }
  if (!apiKey) {
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, provider_config")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .limit(1);
    apiKey = accounts?.[0]?.provider_config?.unipile_api_key;
  }
  if (!apiKey) throw new Error("No Unipile API key available");

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
