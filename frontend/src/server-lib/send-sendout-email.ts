import { logger } from "./logger.js";
import { getMicrosoftAccessToken } from "./microsoft-graph.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Dedicated Microsoft Graph sender for client send-out / submission emails.
 *
 * Kept separate from `send-channels.sendEmail` (which is single-recipient and
 * sequence-critical) so this flow can support multiple `to` recipients, `cc`,
 * and storage-backed PDF attachments without destabilising sequences. Reused by
 * both the immediate path (`/api/send-sendout`) and the scheduled Inngest
 * function (`send-message-scheduled`).
 *
 * Attachments are read from the private `resumes` storage bucket by path.
 */

const ATTACHMENT_BUCKET = "resumes";
const TOTAL_MAX_BYTES = 24 * 1024 * 1024; // Graph hard-limits a message at 25MB

async function resolveSenderEmail(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.email) return profile.email;
  throw new Error(`No email found in profiles for user ${userId}.`);
}

async function appendSignature(supabase: any, userId: string, body: string): Promise<string> {
  try {
    const { data: sigRow } = await supabase
      .from("user_integrations")
      .select("config")
      .eq("user_id", userId)
      .eq("integration_type", "email_signature")
      .eq("is_active", true)
      .maybeSingle();
    const sigHtml = sigRow?.config?.signature_html;
    if (sigHtml) return body + "<br><br>" + sigHtml;
  } catch (err: any) {
    logger.warn("send-sendout: signature fetch failed, sending without", { error: err.message });
  }
  return body;
}

export interface SendoutAttachment {
  /** Storage path inside the `resumes` bucket. */
  path: string;
  /** Filename the recipient sees (e.g. "Jay_Emerald.pdf"). */
  name: string;
  mimeType?: string;
}

export interface SendSendoutEmailInput {
  userId: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** HTML body. Signature is appended when `useSignature` is set. */
  html: string;
  attachments?: SendoutAttachment[];
  useSignature?: boolean;
}

export async function sendSendoutEmail(
  supabase: any,
  input: SendSendoutEmailInput,
): Promise<{ messageId: string; sender: string }> {
  const to = (input.to || []).map((s) => s.trim()).filter(Boolean);
  const cc = (input.cc || []).map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("send-sendout: no recipients");

  const accessToken = await getMicrosoftAccessToken();
  const fromEmail = await resolveSenderEmail(supabase, input.userId);

  let body = input.html || "";
  if (input.useSignature) body = await appendSignature(supabase, input.userId, body);

  // Build Graph fileAttachments from storage, capped at 24MB total.
  const graphAttachments: any[] = [];
  let totalBytes = 0;
  for (const att of input.attachments || []) {
    try {
      const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).download(att.path);
      if (error || !data) throw new Error(error?.message || "download failed");
      const buf = Buffer.from(await data.arrayBuffer());
      if (totalBytes + buf.length > TOTAL_MAX_BYTES) {
        logger.warn("send-sendout: skipping attachment — would exceed 24MB", { path: att.path });
        continue;
      }
      graphAttachments.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: att.name,
        contentType: att.mimeType || "application/pdf",
        contentBytes: buf.toString("base64"),
      });
      totalBytes += buf.length;
    } catch (err: any) {
      logger.warn("send-sendout: attachment fetch failed — skipping", { path: att.path, error: err.message });
    }
  }

  const message: any = {
    subject: input.subject || "",
    body: { contentType: "HTML", content: body },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  };
  if (cc.length) message.ccRecipients = cc.map((address) => ({ emailAddress: { address } }));
  if (graphAttachments.length) message.attachments = graphAttachments;

  // Draft → send (mirrors send-channels.sendEmail: draft returns the message id
  // synchronously; POST …/send delivers it and files it in Sent Items).
  const draftResp = await fetchWithRetry(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    },
  );
  if (!draftResp.ok) {
    const error = await draftResp.text();
    throw new Error(`Graph create-draft error (${fromEmail}): ${error}`);
  }
  const draft = await draftResp.json();
  const draftId: string | undefined = draft?.id;
  const internetMessageId: string | undefined = draft?.internetMessageId || undefined;
  if (!draftId) throw new Error(`Graph create-draft error (${fromEmail}): no message id`);

  const sendResp = await fetchWithRetry(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/messages/${encodeURIComponent(draftId)}/send`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!sendResp.ok) {
    const error = await sendResp.text();
    throw new Error(`Graph send error (${fromEmail}): ${error}`);
  }

  logger.info("send-sendout: email sent via Graph", { from: fromEmail, to: to.length, cc: cc.length, attachments: graphAttachments.length });
  return { messageId: internetMessageId || draftId, sender: fromEmail };
}
