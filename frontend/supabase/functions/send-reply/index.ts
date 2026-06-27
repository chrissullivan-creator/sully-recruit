import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// send-reply: routes a manual reply from the unified inbox to the correct channel
// Supports: email (Graph API), LinkedIn (Unipile), SMS (RingCentral)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_CLIENT_ID = Deno.env.get("MICROSOFT_CLIENT_ID");
const MICROSOFT_CLIENT_SECRET = Deno.env.get("MICROSOFT_CLIENT_SECRET");
const MICROSOFT_TENANT_ID = Deno.env.get("MICROSOFT_TENANT_ID") || "common";
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID");
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET");
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") || "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") || "https://api2.unipile.com:13080";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") || "";
const RC_CLIENT_ID = Deno.env.get("RC_CLIENT_ID") || "";
const RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") || "";
const RC_SERVER = Deno.env.get("RC_SERVER") || "https://platform.ringcentral.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── MICROSOFT TOKEN ────────────────────────────────────────────────────────
function getGraphEmails() {
  return new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}
async function refreshMicrosoftToken(account: Record<string, unknown>): Promise<Record<string, unknown>> {
  const email = String(account.email_address ?? "").toLowerCase().trim();
  const useGraph = getGraphEmails().has(email);
  const clientId = useGraph ? MICROSOFT_GRAPH_CLIENT_ID : MICROSOFT_CLIENT_ID;
  const clientSecret = useGraph ? MICROSOFT_GRAPH_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET;
  const tenantId = useGraph ? MICROSOFT_GRAPH_TENANT_ID : MICROSOFT_TENANT_ID;
  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, grant_type: "refresh_token", refresh_token: String(account.refresh_token), scope: "offline_access Mail.Send Mail.Read User.Read openid profile" }),
  });
  const data: Record<string, unknown> = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(String(data.error_description ?? `Token refresh failed ${resp.status}`));
  const expiresAt = new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString();
  const { data: updated } = await supabase.from("integration_accounts")
    .update({ access_token: data.access_token, refresh_token: data.refresh_token ?? account.refresh_token, token_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("id", account.id).select("*").single();
  return updated as Record<string, unknown>;
}
async function getValidToken(account: Record<string, unknown>): Promise<string> {
  let a = account;
  if (!a.access_token || !a.token_expires_at || new Date(String(a.token_expires_at)).getTime() - Date.now() < 5 * 60000)
    a = await refreshMicrosoftToken(a);
  return String(a.access_token);
}

// ── SEND EMAIL (reply or new) ──────────────────────────────────────────────
async function sendEmailReply(params: {
  account: Record<string, unknown>;
  toEmail: string;
  body: string;
  replyToMessageId: string | null;
  threadSubject: string | null;
  signature: string | null;
}): Promise<{ ok: boolean; graphMessageId?: string; error?: string }> {
  const token = await getValidToken(params.account);
  const senderEmail = String(params.account.email_address);
  const fullBody = params.signature ? `${params.body}<br/><br/>${params.signature}` : params.body;

  if (params.replyToMessageId) {
    // Reply in thread
    const draftResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/messages/${params.replyToMessageId}/createReply`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }
    );
    if (!draftResp.ok) {
      const t = await draftResp.text();
      return { ok: false, error: `createReply failed ${draftResp.status}: ${t}` };
    }
    const draft = await draftResp.json();
    const draftId = draft.id as string;
    await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/messages/${draftId}`,
      { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: { contentType: "HTML", content: fullBody }, toRecipients: [{ emailAddress: { address: params.toEmail } }] }) }
    );
    const sendResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/messages/${draftId}/send`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    if (!sendResp.ok) return { ok: false, error: `send failed ${sendResp.status}` };
    return { ok: true, graphMessageId: draftId };
  }

  // New email
  const subject = params.threadSubject
    ? (params.threadSubject.startsWith("Re:") ? params.threadSubject : `Re: ${params.threadSubject}`)
    : "Following up";
  const draftResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/messages`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body: { contentType: "HTML", content: fullBody }, toRecipients: [{ emailAddress: { address: params.toEmail } }] }) }
  );
  if (!draftResp.ok) return { ok: false, error: `draft create failed ${draftResp.status}` };
  const draft = await draftResp.json();
  const sendResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/messages/${draft.id}/send`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!sendResp.ok) return { ok: false, error: `send failed ${sendResp.status}` };
  return { ok: true, graphMessageId: draft.id };
}

// ── SEND LINKEDIN ──────────────────────────────────────────────────────────
async function sendLinkedInReply(params: {
  account: Record<string, unknown>;
  chatId: string | null;
  recipientUnipileId: string | null;
  body: string;
}): Promise<{ ok: boolean; chatId?: string; messageId?: string; error?: string }> {
  if (!UNIPILE_API_KEY) return { ok: false, error: "Missing UNIPILE_API_KEY" };
  const headers = { "X-API-KEY": UNIPILE_API_KEY, "Content-Type": "application/json", "Accept": "application/json" };

  if (params.chatId) {
    const resp = await fetch(`${UNIPILE_API_URL}/api/v1/chats/${params.chatId}/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ account_id: account.unipile_account_id, text: params.body }),
    });
    const data: Record<string, unknown> = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: `Unipile ${resp.status}: ${JSON.stringify(data)}` };
    return { ok: true, chatId: params.chatId, messageId: (data.id ?? data.message_id) as string };
  }

  if (params.recipientUnipileId) {
    const resp = await fetch(`${UNIPILE_API_URL}/api/v1/chats`, {
      method: "POST", headers,
      body: JSON.stringify({ account_id: params.account.unipile_account_id, attendees_ids: [params.recipientUnipileId], text: params.body }),
    });
    const data: Record<string, unknown> = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: `Unipile ${resp.status}: ${JSON.stringify(data)}` };
    return { ok: true, chatId: (data.chat_id ?? data.id) as string, messageId: (data.message_id) as string };
  }

  return { ok: false, error: "No chatId or recipientUnipileId provided" };
}

// ── SEND SMS ───────────────────────────────────────────────────────────────
async function sendSMSReply(params: {
  account: Record<string, unknown>;
  toNumber: string;
  body: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const jwt = String(params.account.rc_jwt ?? "");
  if (!jwt) return { ok: false, error: "No RC JWT on account" };
  const creds = btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`);
  const tokenResp = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const tokenData: Record<string, unknown> = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok) return { ok: false, error: `RC token ${tokenResp.status}: ${JSON.stringify(tokenData)}` };
  const token = tokenData.access_token as string;

  const resp = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: params.account.rc_phone_number }, to: [{ phoneNumber: params.toNumber }], text: params.body }),
  });
  const data: Record<string, unknown> = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: `RC SMS ${resp.status}: ${JSON.stringify(data)}` };
  return { ok: true, messageId: data.id as string };
}

// ── MAIN ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const {
    candidate_id,
    contact_id,
    channel,           // 'email' | 'linkedin' | 'linkedin_recruiter' | 'linkedin_sales_nav' | 'sms'
    integration_account_id,
    reply_to_message_id,   // Graph message ID for email threading
    unipile_chat_id,       // Unipile chat ID for LinkedIn threading
    recipient_address,     // email address or phone number
    recipient_unipile_id,  // Unipile ID for LinkedIn (fallback if no chat)
    message_body,
    thread_subject,        // original email subject for Re:
  } = body;

  if (!channel) return json({ error: "Missing channel" }, 400);
  if (!message_body) return json({ error: "Missing message_body" }, 400);
  if (!integration_account_id) return json({ error: "Missing integration_account_id" }, 400);

  // Load integration account
  const { data: account, error: acctErr } = await supabase
    .from("integration_accounts")
    .select("*")
    .eq("id", integration_account_id)
    .eq("is_active", true)
    .maybeSingle();
  if (acctErr || !account) return json({ error: "Integration account not found" }, 404);

  // Load sender profile for signature
  let signature: string | null = null;
  if (account.owner_user_id) {
    const { data: profile } = await supabase.from("profiles")
      .select("email_signature").eq("id", account.owner_user_id).maybeSingle();
    signature = profile?.email_signature ?? null;
  }

  const now = new Date().toISOString();
  let result: { ok: boolean; error?: string; graphMessageId?: string; chatId?: string; messageId?: string };
  const sentChannel = String(channel);

  // ── ROUTE BY CHANNEL ────────────────────────────────────────────────────
  if (channel === "email") {
    result = await sendEmailReply({
      account,
      toEmail: String(recipient_address ?? ""),
      body: String(message_body),
      replyToMessageId: reply_to_message_id ? String(reply_to_message_id) : null,
      threadSubject: thread_subject ? String(thread_subject) : null,
      signature,
    });
  } else if (["linkedin", "linkedin_recruiter", "linkedin_sales_nav"].includes(String(channel))) {
    result = await sendLinkedInReply({
      account,
      chatId: unipile_chat_id ? String(unipile_chat_id) : null,
      recipientUnipileId: recipient_unipile_id ? String(recipient_unipile_id) : null,
      body: String(message_body),
    });
  } else if (channel === "sms") {
    result = await sendSMSReply({
      account,
      toNumber: String(recipient_address ?? ""),
      body: String(message_body),
    });
  } else {
    return json({ error: `Unsupported channel: ${channel}` }, 400);
  }

  if (!result.ok) {
    console.error(`[send-reply] ${channel} failed:`, result.error);
    return json({ success: false, error: result.error }, 500);
  }

  // ── LOG TO messages TABLE ────────────────────────────────────────────────
  const conversationId = crypto.randomUUID();
  const msgInsert: Record<string, unknown> = {
    conversation_id: unipile_chat_id ?? conversationId,
    candidate_id: candidate_id ?? null,
    contact_id: contact_id ?? null,
    channel: sentChannel,
    direction: "outbound",
    body: String(message_body),
    topic: thread_subject ?? sentChannel,
    subject: thread_subject ?? null,
    sender_address: account.email_address ?? account.rc_phone_number ?? null,
    recipient_address: recipient_address ?? null,
    integration_account_id: account.id,
    sent_at: now,
    is_read: true,
    updated_at: now,
    inserted_at: now,
    created_at: now,
  };
  if (result.graphMessageId) msgInsert.provider_message_id = result.graphMessageId;
  if (result.messageId) msgInsert.provider_message_id = result.messageId;
  if (result.chatId) msgInsert.unipile_chat_id = result.chatId;
  if (unipile_chat_id) msgInsert.unipile_chat_id = unipile_chat_id;

  const { error: insertErr } = await supabase.from("messages").insert(msgInsert);
  if (insertErr) console.error(`[send-reply] message insert error:`, insertErr.message);

  // Update email thread tracking on any active enrollment
  if (channel === "email" && result.graphMessageId && candidate_id) {
    await supabase.from("sequence_enrollments")
      .update({ email_last_message_id: result.graphMessageId, updated_at: now })
      .eq("candidate_id", String(candidate_id))
      .eq("status", "active");
  }

  console.log(`[send-reply] OK channel=${channel} to=${recipient_address ?? unipile_chat_id}`);
  return json({ success: true, channel: sentChannel, message_id: result.graphMessageId ?? result.messageId ?? null, chat_id: result.chatId ?? unipile_chat_id ?? null });
});
