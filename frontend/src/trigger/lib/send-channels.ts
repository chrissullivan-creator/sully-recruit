import { logger } from "@trigger.dev/sdk/v3";
import { getAppSetting } from "./supabase";
import { getMicrosoftAccessToken } from "./microsoft-graph";
import { fetchWithRetry } from "./fetch-retry";
import { unipileSendEmail, shouldUseUnipileEmail } from "./unipile-email";
import { unipileFetch } from "./unipile-v2";

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
  threadingOptions?: {
    inReplyTo?: string;
    references?: string;
  },
  useSignature?: boolean,
  /**
   * Optional sequence step log id. When provided, a 1x1 transparent
   * tracking pixel is appended to the email body so opens get attributed
   * back to this step via /api/track/open.
   */
  trackingStepLogId?: string,
  /**
   * Optional URLs of files to attach. Each is fetched server-side and
   * embedded as a Microsoft Graph fileAttachment. 25MB Graph limit per
   * message — we cap the *total* across all attachments at 24MB and
   * skip subsequent files once the budget is exhausted.
   *
   * String form is accepted for backward-compat — old call sites passed
   * a single URL.
   */
  attachmentUrls?: string | string[],
): Promise<{ messageId: string; sender: string; internetMessageId?: string }> {
  const accessToken = await getMicrosoftAccessToken();
  const fromEmail = await resolveSenderEmail(supabase, userId);

  // Append email signature if enabled
  if (useSignature) {
    try {
      const { data: sigRow } = await supabase
        .from("user_integrations")
        .select("config")
        .eq("user_id", userId)
        .eq("integration_type", "email_signature")
        .eq("is_active", true)
        .maybeSingle();

      const sigHtml = sigRow?.config?.signature_html;
      if (sigHtml) {
        body = body + "<br><br>" + sigHtml;
      }
    } catch (err: any) {
      logger.warn("Failed to fetch email signature, sending without", { error: err.message });
    }
  }

  // Append 1×1 open-tracking pixel for sequence sends. Tracking host comes
  // from app_settings.TRACKING_BASE_URL (falls back to the public app URL).
  // Skipping is silent: missing host = no pixel = no tracking.
  if (trackingStepLogId) {
    try {
      const { data: hostRow } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "TRACKING_BASE_URL")
        .maybeSingle();
      const host = (hostRow?.value || "").replace(/\/+$/, "");
      if (host) {
        const pixel = `<img src="${host}/api/track/open?id=${encodeURIComponent(trackingStepLogId)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0" />`;
        body = body + pixel;
      }
    } catch {
      // Pixel failure is silent — never block the send.
    }
  }

  // Build the message payload
  const message: any = {
    subject: subject || "",
    body: { contentType: "HTML", content: body },
    toRecipients: [{ emailAddress: { address: to } }],
  };

  // Add reply threading headers if this is a follow-up
  if (threadingOptions?.inReplyTo) {
    message.internetMessageHeaders = [
      { name: "In-Reply-To", value: threadingOptions.inReplyTo },
      { name: "References", value: threadingOptions.references || threadingOptions.inReplyTo },
    ];
  }

  // Attach files (sequence step's branded résumé, cover letter, etc.).
  // Each is fetched server-side and embedded as a standard Graph
  // fileAttachment so the recipient gets them inline. Total payload
  // capped at 24MB across all files (Graph hard-limits at 25MB).
  const urlList = !attachmentUrls
    ? []
    : Array.isArray(attachmentUrls)
      ? attachmentUrls.filter(Boolean)
      : [attachmentUrls];

  if (urlList.length) {
    const TOTAL_MAX_BYTES = 24 * 1024 * 1024;
    const built: any[] = [];
    let totalBytes = 0;
    for (const url of urlList) {
      try {
        const fileResp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!fileResp.ok) throw new Error(`fetch ${fileResp.status}`);
        const buf = Buffer.from(await fileResp.arrayBuffer());
        if (totalBytes + buf.length > TOTAL_MAX_BYTES) {
          logger.warn("Skipping attachment — would exceed 24MB total", { url, totalBytes, fileBytes: buf.length });
          continue;
        }
        let fileName = "attachment";
        try {
          const u = new URL(url);
          const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
          if (last) fileName = last.replace(/^\d+_/, ""); // strip our `${ts}_` prefix
        } catch { /* keep default */ }
        const contentType = fileResp.headers.get("content-type") || "application/octet-stream";
        built.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: fileName,
          contentType,
          contentBytes: buf.toString("base64"),
        });
        totalBytes += buf.length;
      } catch (err: any) {
        logger.warn("Email attachment fetch failed — skipping that file", { url, error: err.message });
      }
    }
    if (built.length) message.attachments = built;
  }

  // Phase 2 of the Unipile-everywhere migration: when the kill-switch
  // app_settings.USE_UNIPILE_EMAIL is on, route the send through
  // Unipile Outlook instead. The body already has signature +
  // tracking pixel appended, so we just hand it across.
  // Failure falls back to Graph so a misconfigured Unipile account
  // never blocks a live sequence step.
  if (await shouldUseUnipileEmail()) {
    try {
      const result = await unipileSendEmail(supabase, {
        fromEmail,
        to: [{ address: to }],
        subject: subject || "",
        htmlBody: body,
        inReplyTo: threadingOptions?.inReplyTo,
        attachmentUrls: urlList,
      });
      logger.info("Email sent via Unipile", { from: fromEmail, to, hasThreading: !!threadingOptions?.inReplyTo });
      return {
        messageId: result.messageId,
        sender: fromEmail,
        internetMessageId: result.internetMessageId,
      };
    } catch (err: any) {
      logger.warn("sendEmail: Unipile failed, falling back to Graph", {
        fromEmail, to, error: err.message,
      });
    }
  }

  const response = await fetchWithRetry(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Microsoft Graph sendMail error (${fromEmail}): ${error}`);
  }

  // Try to capture the real internetMessageId from Sent Items
  let internetMessageId: string | undefined;
  try {
    const sentResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/mailFolders/SentItems/messages?$top=1&$orderby=sentDateTime desc&$select=internetMessageId&$filter=toRecipients/any(r:r/emailAddress/address eq '${to}')`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (sentResp.ok) {
      const sentData = await sentResp.json();
      internetMessageId = sentData.value?.[0]?.internetMessageId;
    }
  } catch {
    // Non-fatal — worst case we don't get threading on next reply step
  }

  const messageId = internetMessageId || `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info("Email sent via Graph", { from: fromEmail, to, hasThreading: !!threadingOptions?.inReplyTo });
  return { messageId, sender: fromEmail, internetMessageId };
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
 * Ashley has NO RingCentral — will throw if SMS is attempted for her.
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
    throw new Error(`No RingCentral integration for user ${userId}. Not all users have RingCentral — don't route SMS to them.`);
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

  const smsResponse = await fetchWithRetry(
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
 * Find the Unipile API key and account ID for a specific user.
 * API key comes from app_settings (global), account ID from integration_accounts (per-user).
 */
async function getUnipileApiKey(
  supabase: any,
  userId?: string,
  accountId?: string,
): Promise<{ apiKey: string; accountId: string }> {
  const apiKey = await getAppSetting("UNIPILE_API_KEY");

  // 1. Try explicit accountId
  if (accountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id")
      .eq("id", accountId)
      .single();
    if (account) {
      return { apiKey, accountId: account.unipile_account_id || account.id };
    }
  }

  // 2. Try by owner_user_id
  if (userId) {
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id")
      .eq("owner_user_id", userId)
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null)
      .limit(1);

    if (accounts?.[0]) {
      return { apiKey, accountId: accounts[0].unipile_account_id || accounts[0].id };
    }
  }

  // 3. Auto-discover any active LinkedIn account
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, unipile_account_id")
    .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .limit(1);

  if (accounts?.[0]) {
    return { apiKey, accountId: accounts[0].unipile_account_id || accounts[0].id };
  }

  throw new Error("No active LinkedIn/Unipile account found");
}

/**
 * Verify that the Unipile account is still connected and healthy.
 * Throws if the account is disconnected or the API is unreachable.
 *
 * v2 has no per-account endpoint at this position — account state
 * lives at /api/v2/accounts/{id} (still supported, no path-account-id
 * shape because this is a meta endpoint). Use it directly with the
 * v2 base URL + key.
 */
async function verifyUnipileAccountHealth(supabase: any, accountId: string): Promise<void> {
  const [{ data: v2Row }, { data: v1Row }, { data: v2KeyRow }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const base = (v2Row?.value || "").replace(/\/+$/, "")
    || (v1Row?.value || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "/api/v2");
  const apiKey = v2KeyRow?.value || v1KeyRow?.value;
  if (!base || !apiKey) throw new Error("Unipile config missing");
  try {
    const resp = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      throw new Error(`Unipile account check failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const status = data.status || data.connection_status;
    if (status && status !== "OK" && status !== "CONNECTED" && status !== "connected") {
      logger.warn("Unipile account unhealthy", { accountId, status });
      throw new Error(`Unipile account ${accountId} is ${status} — reconnect in Unipile dashboard`);
    }
  } catch (err: any) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error("Unipile API unreachable — health check timed out");
    }
    throw err;
  }
}

export async function sendLinkedIn(
  supabase: any,
  to: string,
  body: string,
  userId?: string,
  accountId?: string,
  stepChannel?: string,
  /**
   * Optional URLs of files to attach. Unipile's /messages endpoint
   * accepts one or more `attachments` form-data fields. Connection
   * requests have a hard 200-char-only payload (no files), so any
   * attachments are silently dropped on that path.
   *
   * String form is accepted for back-compat with old call sites.
   */
  attachmentUrls?: string | string[],
): Promise<{ message_id: string; conversation_id: string }> {
  const { accountId: resolvedAccountId } = await getUnipileApiKey(supabase, userId, accountId);

  // Health check uses v2 base — /accounts/{id} is unchanged across versions.
  await verifyUnipileAccountHealth(supabase, resolvedAccountId);

  // ── Resolve LinkedIn URL → provider_id via v2 ───────────────────
  // v2 path: GET /api/v2/{account_id}/linkedin/users/{slug}
  let providerId = to;
  if (to.includes("linkedin.com/")) {
    const match = to.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) {
      try {
        const userData: any = await unipileFetch(
          supabase,
          resolvedAccountId,
          `linkedin/users/${encodeURIComponent(match[1])}`,
          { method: "GET" },
        );
        providerId = userData.provider_id || userData.id || userData.public_id || match[1];
      } catch (err: any) {
        throw new Error(`Could not resolve LinkedIn profile ${match[1]}: ${err.message}`);
      }
    }
  }

  // recruiter_inmail (Nancy's Recruiter InMail via Unipile)
  const isInMailChannel =
    stepChannel === "recruiter_inmail" ||
    stepChannel === "linkedin_recruiter";
  const isConnectionRequest = stepChannel === "linkedin_connection";

  // Credit guard: InMails cost real money. The hourly sync stamps
  // remaining credits onto integration_accounts; if we know the
  // bucket is empty, fail fast with a clear message instead of
  // letting Unipile 422 us with a generic error.
  if (isInMailChannel) {
    const { data: acct } = await supabase
      .from("integration_accounts")
      .select("inmail_credits_remaining, inmail_credits_updated_at, account_label")
      .eq("unipile_account_id", resolvedAccountId)
      .maybeSingle();
    if (
      acct?.inmail_credits_remaining !== null &&
      acct?.inmail_credits_remaining !== undefined &&
      acct.inmail_credits_remaining <= 0
    ) {
      throw new Error(
        `InMail credits exhausted on ${acct.account_label || resolvedAccountId}` +
        ` (last checked ${acct.inmail_credits_updated_at}). ` +
        `Top up before re-running.`,
      );
    }
  }

  // ── Connection request via v2 ───────────────────────────────────
  // v2 path: POST /api/v2/{account_id}/linkedin/users/invite
  // (account_id moves to path; body no longer needs it)
  if (isConnectionRequest) {
    const data: any = await unipileFetch(
      supabase,
      resolvedAccountId,
      `linkedin/users/invite`,
      {
        method: "POST",
        body: JSON.stringify({ provider_id: providerId, message: body }),
      },
    );
    return {
      message_id: data.id || `invite_${Date.now()}`,
      conversation_id: data.conversation_id || "",
    };
  }

  // ── Regular message + InMail via v2 ─────────────────────────────
  // v2 path: POST /api/v2/{account_id}/linkedin/chats
  // Body: { attendees_ids: [providerId], text, message_type? }
  //   - Classic message:  no message_type
  //   - Recruiter InMail: message_type = "INMAIL"
  //
  // Use multipart when one or more attachments are present so Unipile
  // picks up each file via its `attachments` field. Attachments are
  // skipped for connection requests (handled above) since invitations
  // have a 200-char text-only payload.
  const linkedinUrls = !attachmentUrls
    ? []
    : Array.isArray(attachmentUrls)
      ? attachmentUrls.filter(Boolean)
      : [attachmentUrls];

  if (linkedinUrls.length) {
    const blobs: { blob: Blob; name: string }[] = [];
    const PER_FILE_MAX = 20 * 1024 * 1024;
    for (const url of linkedinUrls) {
      try {
        const fileResp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!fileResp.ok) throw new Error(`fetch ${fileResp.status}`);
        const buf = await fileResp.arrayBuffer();
        if (buf.byteLength > PER_FILE_MAX) {
          logger.warn("Skipping LinkedIn attachment — over 20MB", { url, bytes: buf.byteLength });
          continue;
        }
        const contentType = fileResp.headers.get("content-type") || "application/octet-stream";
        let fileName = "attachment";
        try {
          const u = new URL(url);
          const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
          if (last) fileName = last.replace(/^\d+_/, "");
        } catch { /* keep default */ }
        blobs.push({ blob: new Blob([buf], { type: contentType }), name: fileName });
      } catch (err: any) {
        logger.warn("LinkedIn attachment fetch failed — skipping that file", { url, error: err.message });
      }
    }

    if (blobs.length) {
      const fd = new FormData();
      fd.append("attendees_ids", providerId);
      fd.append("text", body);
      // Per Unipile v2 SDK (chat-start.types.ts): use the `linkedin`
      // field, not a top-level message_type.
      //   InMail (Recruiter seat):  { linkedin: { api: 'recruiter' } }
      //   Classic DM:               omit linkedin (defaults to classic)
      if (isInMailChannel) {
        fd.append("linkedin", JSON.stringify({ api: "recruiter" }));
      }
      for (const { blob, name } of blobs) {
        fd.append("attachments", blob, name);
      }

      try {
        const data: any = await unipileFetch(
          supabase,
          resolvedAccountId,
          `linkedin/chats`,
          { method: "POST", body: fd as any },
        );
        if (isInMailChannel) await decrementInmailCredit(supabase, resolvedAccountId);
        return {
          message_id: data.id || data.message_id || `msg_${Date.now()}`,
          conversation_id: data.chat_id || data.conversation_id || "",
        };
      } catch (err: any) {
        if (isInMailChannel && /\b422\b/.test(err.message)) {
          throw new Error(`InMail ${err.message}`);
        }
        throw new Error(`Unipile send error: ${err.message}`);
      }
    }
    // Every attachment failed — fall through to the JSON path so the
    // message itself still goes out.
  }

  const sendPayload: any = { attendees_ids: [providerId], text: body };
  // Per Unipile v2 SDK: route InMail through linkedin.api='recruiter'.
  // Classic DMs need no extras (default).
  if (isInMailChannel) sendPayload.linkedin = { api: "recruiter" };

  try {
    const data: any = await unipileFetch(
      supabase,
      resolvedAccountId,
      `linkedin/chats`,
      {
        method: "POST",
        body: JSON.stringify(sendPayload),
      },
    );
    if (isInMailChannel) await decrementInmailCredit(supabase, resolvedAccountId);
    return {
      message_id: data.id || data.message_id || `msg_${Date.now()}`,
      conversation_id: data.chat_id || data.conversation_id || "",
    };
  } catch (err: any) {
    if (isInMailChannel && /\b422\b/.test(err.message)) {
      throw new Error(`InMail ${err.message}`);
    }
    throw new Error(`Unipile send error: ${err.message}`);
  }
}

/**
 * Best-effort: subtract 1 from the cached credit count after a
 * confirmed InMail send. The hourly sync overwrites with the truth,
 * so a brief race here is harmless. Failure is silent — never block
 * a successful send because the local counter couldn't update.
 */
async function decrementInmailCredit(supabase: any, unipileAccountId: string): Promise<void> {
  try {
    const { data: row } = await supabase
      .from("integration_accounts")
      .select("inmail_credits_remaining")
      .eq("unipile_account_id", unipileAccountId)
      .maybeSingle();
    const current = row?.inmail_credits_remaining;
    if (typeof current === "number" && current > 0) {
      await supabase
        .from("integration_accounts")
        .update({ inmail_credits_remaining: current - 1 } as any)
        .eq("unipile_account_id", unipileAccountId);
    }
  } catch {
    // Silent — the cached counter is decorative, not authoritative.
  }
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
  if (channel === "email") {
    // Pick the right email column for the role: candidates → personal_email,
    // clients (entityType="contact") → work_email. Falls back to the legacy
    // `primary_email` column during the migration off it.
    const { data: entity } = await supabase
      .from("people")
      .select("type, primary_email, work_email, personal_email")
      .eq("id", entityId)
      .single();
    const to =
      entity?.type === "candidate"
        ? (entity?.personal_email || entity?.primary_email)
        : (entity?.work_email || entity?.primary_email);
    if (!to) throw new Error(`No email for ${entityType} ${entityId}`);
    return { to, conversationId: null };
  }

  if (channel === "sms") {
    const { data: entity } = await supabase.from("people").select("phone").eq("id", entityId).single();
    if (!entity?.phone) throw new Error(`No phone for ${entityType} ${entityId}`);
    return { to: entity.phone, conversationId: null };
  }

  // LinkedIn channels — resolve Unipile provider_id.
  //
  // Cache lookup order (no Unipile API call needed if we hit any of these):
  //   1. people.unipile_provider_id  (populated by the resolve-unipile-ids
  //      task — works for candidates AND clients)
  //   2. candidate_channels.provider_id  (legacy cache, candidate-only)
  //
  // Only hit Unipile's user-lookup endpoint as a last resort. The lookup
  // moved to v2 (`/api/v2/{account_id}/users/{slug}`); the legacy v1 path
  // returns 404 for many slugs and was the cause of this morning's 14
  // InMail skips.
  const { data: peopleRow } = await supabase
    .from("people")
    .select("unipile_provider_id, unipile_classic_id, unipile_recruiter_id, linkedin_url")
    .eq("id", entityId)
    .maybeSingle();
  const cachedFromPeople =
    peopleRow?.unipile_provider_id || peopleRow?.unipile_classic_id || peopleRow?.unipile_recruiter_id;
  if (cachedFromPeople) {
    return { to: cachedFromPeople, conversationId: null };
  }

  // Legacy candidate_channels cache (kept for already-resolved candidates).
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

  if (!peopleRow?.linkedin_url) throw new Error(`No LinkedIn URL for ${entityType} ${entityId}`);

  const match = peopleRow.linkedin_url.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!match) throw new Error(`Invalid LinkedIn URL: ${peopleRow.linkedin_url}`);

  // v2 path: GET /api/v2/{account_id}/linkedin/users/{slug} via the
  // shared unipileFetch helper that already handles base URL + API key.
  const { accountId: resolvedAccountId } = await getUnipileApiKey(supabase, userId, accountId);
  const userData: any = await unipileFetch(
    supabase,
    resolvedAccountId,
    `linkedin/users/${encodeURIComponent(match[1])}`,
    { method: "GET" },
  );
  const resolvedId = userData.provider_id || userData.id;
  if (!resolvedId) throw new Error(`Unipile returned no provider_id for ${match[1]}`);

  // Cache to people.unipile_provider_id so future sends skip the lookup
  // (works for both candidates and clients — single source of truth).
  await supabase
    .from("people")
    .update({ unipile_provider_id: resolvedId, unipile_resolve_status: "resolved" } as any)
    .eq("id", entityId);

  // Mirror to candidate_channels for legacy reads (candidate-only).
  if (entityType === "candidate") {
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
  }

  return { to: resolvedId, conversationId: null };
}
