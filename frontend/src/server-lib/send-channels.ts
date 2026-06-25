import { logger } from "./logger.js";
import { getAppSetting } from "./supabase.js";
import { getMicrosoftAccessToken } from "./microsoft-graph.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { unipileSendEmail, shouldUseUnipileEmail } from "./unipile-email.js";
import {
  unipileFetch,
  unipileFetchV2,
  isLinkedinV2SendEnabled,
  getUnipileAccountV2IdByV1Id,
} from "./unipile-v2.js";
import { notifyError } from "./alerting.js";

// Unipile v2 SEND path templates. The canonical copies live in
// api/lib/unipile-urls.ts (`messagingV2`); they are inlined here to avoid a
// src/server-lib → api/lib import (the only established cross-dir direction is
// api/ → src/server-lib, and the Vercel bundler can't always follow the
// reverse). Keep these in sync with `messagingV2`.
//
// READS at these paths are verified live (backfill-linkedin-messages-v2.ts).
// SENDS are now LIVE: USE_LINKEDIN_V2_SEND is ON and the classic-DM POST
// shape (`chats`) is proven by production traffic (157 sends in the 30d to
// 2026-06-19). The connection-request (`users/invite`) shape rides the same
// live path. Recruiter InMail (`chats` + linkedin.api='recruiter') is the
// least battle-tested shape — see the note at its call site.
const linkedinV2SendPaths = {
  chatMessages: (chatId: string) => `chats/${encodeURIComponent(chatId)}/messages`,
  chats: () => "chats",
  usersInvite: () => "users/invite",
  user: (providerId: string) => `users/${encodeURIComponent(providerId)}`,
  // Classic DM new-chat send (body `specifics.linkedin.classic`).
  chatsSend: () => "chats/send",
  // Recruiter InMail new-chat send. Recruiter is NOT supported on the
  // top-level `chats/send` (returns 501 "use the inbox endpoint"); it must
  // start the chat from the RECRUITER_PRIMARY inbox. Same body shape
  // { text, users_ids, specifics:{linkedin:{recruiter:{subject,signature}}} }.
  // Route + `specifics` key (NOT `options`) both confirmed live.
  inboxChatsSend: (inboxId: string) => `inboxes/${encodeURIComponent(inboxId)}/chats/send`,
};

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

  // Create the email as a draft first, then send it. Graph's /sendMail is
  // fire-and-forget (202, no body); the old path then polled Sent Items for
  // the internetMessageId, which raced — the just-sent message usually wasn't
  // indexed yet, so we captured nothing (verified: 0/537 recent sends got an
  // id). A missing id meant the next sequence step couldn't thread AND lost
  // its subject, so follow-ups went out as brand-new, subjectless emails.
  // Creating a draft returns the server-assigned internetMessageId
  // synchronously; POST …/send then delivers it (auto-filed in Sent Items).
  const createDraft = (withHeaders: boolean) =>
    fetchWithRetry(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          withHeaders ? message : { ...message, internetMessageHeaders: undefined },
        ),
      },
    );

  let draftResp = await createDraft(true);
  // Defensive: if Graph rejects the custom In-Reply-To/References headers,
  // retry without them rather than failing the send. We still thread by
  // subject (the follow-up's "Re: …" is set upstream).
  if (!draftResp.ok && message.internetMessageHeaders) {
    const errTxt = await draftResp.text();
    logger.warn("Graph draft create failed with threading headers — retrying without them", {
      fromEmail, to, error: errTxt.slice(0, 200),
    });
    draftResp = await createDraft(false);
  }
  if (!draftResp.ok) {
    const error = await draftResp.text();
    throw new Error(`Microsoft Graph create-draft error (${fromEmail}): ${error}`);
  }

  const draft = await draftResp.json();
  const draftId: string | undefined = draft?.id;
  const internetMessageId: string | undefined = draft?.internetMessageId || undefined;
  if (!draftId) {
    throw new Error(`Microsoft Graph create-draft error (${fromEmail}): no message id returned`);
  }

  const sendResp = await fetchWithRetry(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/messages/${encodeURIComponent(draftId)}/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!sendResp.ok) {
    const error = await sendResp.text();
    throw new Error(`Microsoft Graph send error (${fromEmail}): ${error}`);
  }

  const messageId = internetMessageId || draftId;
  logger.info("Email sent via Graph", {
    from: fromEmail,
    to,
    hasThreading: !!threadingOptions?.inReplyTo,
    capturedMessageId: !!internetMessageId,
  });
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

  // 1. Try explicit accountId. Filter for active + non-null
  //    unipile_account_id — without these, a stale or unconfigured row
  //    falls back to `account.id` (a Supabase UUID), which Unipile 404s
  //    on. Alert when a caller asks for a specific account we can't
  //    use, so the misconfiguration surfaces instead of silently
  //    dropping the send.
  if (accountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, is_active, account_type")
      .eq("id", accountId)
      .eq("is_active", true)
      .not("unipile_account_id", "is", null)
      .maybeSingle();
    if (account?.unipile_account_id) {
      return { apiKey, accountId: account.unipile_account_id };
    }
    await notifyError({
      taskId: "send-channels.getUnipileApiKey",
      severity: "WARN",
      error: new Error(`Explicit integration_account ${accountId} is inactive or has no unipile_account_id`),
      context: { requestedAccountId: accountId, ownerUserId: userId },
    });
    // Intentional fall-through to paths 2/3 — better to send via a
    // valid account than to fail closed.
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
 * Read the kill-switch for the inbox-scoped LinkedIn send path.
 *
 * Historically this routed sends to v2's inbox-scoped endpoint
 * (`POST /v2/{account_id}/inboxes/{inbox_id}/chats/send`). v1 has no
 * inbox concept, so when the flag is on `sendViaInboxEndpoint` now
 * throws and we fall through to the legacy `POST /chats` path. Leave
 * the flag OFF in production.
 */
async function shouldUseLinkedInInboxApi(): Promise<boolean> {
  try {
    const v = await getAppSetting("USE_LINKEDIN_INBOX_API");
    return String(v || "").toLowerCase() === "true" || v === "1";
  } catch {
    return false;
  }
}

/**
 * Resolve the recruiter's display name from profiles. Used as the
 * `signature` field on LinkedIn Recruiter sends — Unipile rejects
 * RECRUITER_PRIMARY sends with no signature.
 */
async function getLinkedInSenderName(supabase: any, userId?: string): Promise<string> {
  if (!userId) return "";
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    return profile?.display_name || "";
  } catch {
    return "";
  }
}

/**
 * Fetch attachment URLs and return Unipile's base64-in-JSON shape
 * used by the inbox-scoped send endpoint. Per-file capped at 20 MB
 * (LinkedIn's combined-attachment ceiling); over-size files are
 * dropped with a warning so the text still goes out.
 */
async function buildInboxAttachments(
  urls: string[],
): Promise<{ content: string; content_type: string; filename: string }[]> {
  if (!urls.length) return [];
  const PER_FILE_MAX = 20 * 1024 * 1024;
  const out: { content: string; content_type: string; filename: string }[] = [];
  for (const url of urls) {
    try {
      const fileResp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!fileResp.ok) throw new Error(`fetch ${fileResp.status}`);
      const buf = await fileResp.arrayBuffer();
      if (buf.byteLength > PER_FILE_MAX) {
        logger.warn("Skipping LinkedIn attachment — over 20MB", { url, bytes: buf.byteLength });
        continue;
      }
      const content_type = fileResp.headers.get("content-type") || "application/octet-stream";
      let filename = "attachment";
      try {
        const u = new URL(url);
        const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
        if (last) filename = last.replace(/^\d+_/, "");
      } catch { /* keep default */ }
      out.push({
        content: Buffer.from(buf).toString("base64"),
        content_type,
        filename,
      });
    } catch (err: any) {
      logger.warn("LinkedIn attachment fetch failed — skipping that file", { url, error: err.message });
    }
  }
  return out;
}

/**
 * Inbox-scoped send was a v2-only shape
 * (POST /v2/{account_id}/inboxes/{inbox_id}/chats/send). v1 has no
 * inbox concept — all chats / messages live at the top level. We
 * throw here so the caller falls through to the legacy /chats path
 * (which IS the equivalent on v1: POST /chats?account_id=X with
 * linkedin.api='recruiter' for InMail). The USE_LINKEDIN_INBOX_API
 * kill switch should stay OFF in production.
 */
async function sendViaInboxEndpoint(
  _supabase: any,
  _resolvedAccountId: string,
  _providerId: string,
  _text: string,
  _opts: {
    isInMail: boolean;
    subject?: string;
    signature?: string;
    attachments?: { content: string; content_type: string; filename: string }[];
  },
): Promise<{ message_id: string; conversation_id: string }> {
  throw new Error(
    "Inbox-scoped LinkedIn send is not available on v1. "
    + "Turn off USE_LINKEDIN_INBOX_API so sends fall back to POST /chats.",
  );
}

/**
 * Verify that the Unipile account is still connected and healthy.
 * Throws if the account is disconnected or the API is unreachable.
 *
 * v1 route confirmed via probe:
 *   GET /api/v1/accounts/{account_id}
 * (account_id is in the path here because /accounts is a meta route
 * scoped by id, not by query.)
 */
async function verifyUnipileAccountHealth(supabase: any, accountId: string): Promise<void> {
  const [{ data: v1Row }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const base = (v1Row?.value || "").replace(/\/+$/, "")
    || "https://api19.unipile.com:14926/api/v1";
  const apiKey = v1KeyRow?.value;
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

/**
 * Unipile **v2** LinkedIn send path. Flag-gated (USE_LINKEDIN_V2_SEND) and
 * only reached when the account has a canonical acc_xxx id. Mirrors the v1
 * branch of sendLinkedIn (provider_id resolution, connection-invite vs
 * classic DM vs Recruiter InMail, credit decrement) but routes through
 * unipileFetchV2 against the v2 host.
 *
 * Health check: v2 has no /accounts/{id} equivalent wired here, and the v2
 * READ path (backfill) already proves the account is reachable, so we skip
 * the v1-style verifyUnipileAccountHealth on this path — a failed send
 * surfaces the real Unipile error anyway.
 *
 * Status: USE_LINKEDIN_V2_SEND is ON in production. The classic-DM send
 * shape (POST `chats`) is proven by live traffic; the connection-request
 * shape (POST `users/invite`) rides the same live path. Recruiter InMail
 * (POST `chats` + linkedin.api='recruiter') is the least-exercised shape —
 * verify against Unipile's v2 Methods reference if InMail sends misbehave.
 *
 * Attachments are not yet supported on the v2 path (the v2 multipart shape is
 * unverified); when files are present we send the text only and warn, so a
 * step never silently drops its message.
 */
async function sendLinkedInV2(
  supabase: any,
  acctV2Id: string,
  providerId: string,
  body: string,
  resolvedAccountId: string,
  opts: {
    isInMailChannel: boolean;
    isConnectionRequest: boolean;
    hasAttachments: boolean;
    /** Recruiter InMail subject — required by LinkedIn for a recruiter send. */
    subject?: string;
    /** Recruiter signature (sender display name) — also required. */
    signature?: string;
  },
): Promise<{ message_id: string; conversation_id: string }> {
  // ── Connection request via v2 ───────────────────────────────────
  // v1 equivalent: POST users/invite { provider_id, message }.
  //   path `users/invite`, body { provider_id, message }. Live on the v2
  //   send path; if invites start failing, re-check whether v2 wants
  //   `identifier`/`recipient` for the key or `body` for the message field.
  if (opts.isConnectionRequest) {
    const data: any = await unipileFetchV2(
      supabase,
      acctV2Id,
      linkedinV2SendPaths.usersInvite(),
      {
        method: "POST",
        body: JSON.stringify({ provider_id: providerId, message: body }),
      },
    );
    return {
      message_id: data.id || data.invitation_id || `invite_${Date.now()}`,
      conversation_id: data.conversation_id || data.chat_id || "",
    };
  }

  if (opts.hasAttachments) {
    logger.warn("sendLinkedInV2: attachments not supported on v2 path yet — sending text only", {
      channel: opts.isInMailChannel ? "linkedin_recruiter" : "linkedin",
    });
  }

  // ── New-chat send (classic DM + Recruiter InMail) via v2 ─────────
  // Body shape is identical for both (confirmed live):
  //   { text, users_ids: [providerId], specifics: { linkedin: {...} } }
  // `specifics.linkedin.recruiter` (subject + signature, both required)
  // selects InMail; `specifics.linkedin.classic` selects a classic DM.
  // Routes differ: classic posts to the top-level `chats/send`; recruiter
  // InMail 501s there ("use the inbox endpoint") and must post to the
  // RECRUITER_PRIMARY inbox's `chats/send`. The `options` key and the
  // `chats` / `inboxes/{id}/chats` routes were all rejected (400/404/501).
  const specifics = opts.isInMailChannel
    ? { linkedin: { recruiter: { subject: opts.subject || "Message", signature: opts.signature || "" } } }
    : { linkedin: { classic: {} } };
  const sendPath = opts.isInMailChannel
    ? linkedinV2SendPaths.inboxChatsSend("RECRUITER_PRIMARY")
    : linkedinV2SendPaths.chatsSend();
  try {
    const data: any = await unipileFetchV2(
      supabase,
      acctV2Id,
      sendPath,
      {
        method: "POST",
        body: JSON.stringify({ text: body, users_ids: [providerId], specifics }),
      },
    );
    if (opts.isInMailChannel) await decrementInmailCredit(supabase, resolvedAccountId);
    return {
      message_id: data.message_id || data.id || `msg_${Date.now()}`,
      conversation_id: data.chat_id || data.conversation_id || "",
    };
  } catch (err: any) {
    if (opts.isInMailChannel) throw new Error(`InMail ${err.message}`);
    throw new Error(`Unipile v2 send error: ${err.message}`);
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
  /**
   * Subject line. Required for Recruiter InMail when the new
   * inbox-scoped endpoint is in use (USE_LINKEDIN_INBOX_API=true);
   * ignored on Classic DMs and on the legacy `/chats` fallback path.
   */
  subject?: string,
): Promise<{ message_id: string; conversation_id: string }> {
  const { accountId: resolvedAccountId } = await getUnipileApiKey(supabase, userId, accountId);

  // ── v2 send routing decision ─────────────────────────────────────
  // Take the v2 path ONLY when the USE_LINKEDIN_V2_SEND flag is on AND
  // the resolved account has a canonical acc_xxx id. Either condition
  // missing → fall through to the existing v1 path verbatim. Flag
  // defaults off, so this is a no-op until someone flips it.
  let acctV2Id: string | null = null;
  if (await isLinkedinV2SendEnabled(supabase)) {
    acctV2Id = await getUnipileAccountV2IdByV1Id(supabase, resolvedAccountId);
  }
  const useV2 = !!acctV2Id;

  // Health check via v1: GET /api/v1/accounts/{id}. Skipped on the v2
  // path — v2 has no /accounts/{id} equivalent wired here, and the v2
  // READ path (backfill) already proves the account is reachable; a
  // failed v2 send surfaces the real Unipile error anyway.
  if (!useV2) {
    await verifyUnipileAccountHealth(supabase, resolvedAccountId);
  }

  // ── Resolve LinkedIn URL → provider_id via v1 ───────────────────
  // unipileFetch translates `linkedin/users/{slug}` → v1 `users/{slug}`
  // and adds account_id as a query parameter.
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

  // ── v2 send dispatch ─────────────────────────────────────────────
  // When the flag + acc_xxx are present, route the whole send (connection
  // invite / classic DM / Recruiter InMail) through the v2 host. The credit
  // guard above already ran (it reads our cached counter, API-agnostic).
  // The classic-DM v2 send shape is proven by live traffic; InMail is the
  // least-exercised path — see the notes in sendLinkedInV2.
  if (useV2 && acctV2Id) {
    const hasAttachments = Array.isArray(attachmentUrls)
      ? attachmentUrls.filter(Boolean).length > 0
      : !!attachmentUrls;
    // Recruiter InMail requires a signature (sender display name) alongside
    // the subject; LinkedIn rejects the send without both.
    const signature = isInMailChannel ? await getLinkedInSenderName(supabase, userId) : undefined;
    return sendLinkedInV2(supabase, acctV2Id, providerId, body, resolvedAccountId, {
      isInMailChannel,
      isConnectionRequest,
      hasAttachments,
      subject,
      signature,
    });
  }

  // ── Connection request via v1 ───────────────────────────────────
  // unipileFetch translates `linkedin/users/invite` → v1 `users/invite`
  // and adds account_id as a query parameter.
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

  // ── Regular message + InMail via v1 ─────────────────────────────
  // v1 path: POST /api/v1/chats?account_id=X
  // Body: { attendees_ids: [providerId], text, linkedin? }
  //   - Classic message:  omit linkedin
  //   - Recruiter InMail: linkedin = { api: "recruiter" }
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

  // ── Phase 2 migration: inbox-scoped endpoint ────────────────────
  // When the kill-switch is on, route through
  //   POST /v2/{account_id}/inboxes/{inbox_id}/chats/send
  // which is the shape current Unipile docs describe. Recruiter
  // sends pick up `subject` + `signature` here (LinkedIn requires
  // both). Any failure falls through to the legacy `/chats` path
  // below so a misconfigured rollout never blocks a live sequence
  // step.
  if (await shouldUseLinkedInInboxApi()) {
    try {
      const signature = isInMailChannel
        ? await getLinkedInSenderName(supabase, userId)
        : undefined;
      const inboxAttachments = await buildInboxAttachments(linkedinUrls);
      const result = await sendViaInboxEndpoint(
        supabase, resolvedAccountId, providerId, body,
        { isInMail: isInMailChannel, subject, signature, attachments: inboxAttachments },
      );
      if (isInMailChannel) await decrementInmailCredit(supabase, resolvedAccountId);
      logger.info("LinkedIn sent via inbox endpoint", {
        inbox: isInMailChannel ? "RECRUITER_PRIMARY" : "CLASSIC_PRIMARY",
        hasAttachments: inboxAttachments.length > 0,
      });
      return result;
    } catch (err: any) {
      logger.warn("sendLinkedIn: inbox endpoint failed, falling back to /chats", {
        channel: stepChannel,
        error: err.message,
      });
      // Fall through to legacy path.
    }
  }

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
      // Per Unipile SDK (chat-start.types.ts): use the `linkedin`
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
          `chats`,
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
  // Per Unipile SDK: route InMail through linkedin.api='recruiter'.
  // Classic DMs need no extras (default).
  if (isInMailChannel) sendPayload.linkedin = { api: "recruiter" };

  try {
    const data: any = await unipileFetch(
      supabase,
      resolvedAccountId,
      `chats`,
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
  // uses v1 (`GET /api/v1/users/{slug}?account_id=X`) — our v2 app
  // returns 403 Insufficient permissions on /linkedin/users/{slug}.
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

  // unipileFetch translates `linkedin/users/{slug}` → v1 `users/{slug}`
  // and adds account_id as a query parameter.
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
