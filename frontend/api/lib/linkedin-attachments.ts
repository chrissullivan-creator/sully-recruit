/**
 * Download LinkedIn / Recruiter (InMail) message attachments from Unipile and
 * store them in the `message-attachments` Supabase Storage bucket — mirroring
 * the Outlook/Graph path in process-microsoft-event.ts so the inbox renders
 * them identically (MessageAttachmentList → signed URL from storage_path).
 *
 * Why download instead of linking the Unipile URL directly: the attachment
 * `url` Unipile gives us (…/chats/{chat}/messages/{msg}/attachments/{id}) only
 * resolves with the `X-API-KEY` header — the browser can't fetch it. So we pull
 * the bytes server-side and re-host them privately.
 *
 * Unipile v2 attachment shape (from the message payload's `attachments[]`):
 *   { id, url, type:"file"|"img"|…, object:"Attachment",
 *     filename, mimetype, file_size }
 */

const MESSAGE_ATTACHMENTS_BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB — matches the email path

export interface StoredAttachment {
  name: string;
  storage_path: string;
  mime_type: string | null;
  size: number | null;
}

interface MiniLogger {
  warn?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
}

let _cachedKey: { key: string; base: string; at: number } | null = null;

/** Resolve the Unipile v2 API key + base from app_settings (cached 5 min).
 *  Falls back to the v1 key so a misconfig 401s clearly rather than throwing. */
async function resolveV2Creds(supabase: any): Promise<{ key: string; base: string } | null> {
  const now = Date.now();
  if (_cachedKey && now - _cachedKey.at < 5 * 60 * 1000) {
    return { key: _cachedKey.key, base: _cachedKey.base };
  }
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["UNIPILE_API_KEY_V2", "UNIPILE_API_KEY", "UNIPILE_BASE_V2_URL"]);
  let keyV2 = "";
  let keyV1 = "";
  let base = "";
  for (const row of data ?? []) {
    if (row.key === "UNIPILE_API_KEY_V2") keyV2 = row.value || "";
    else if (row.key === "UNIPILE_API_KEY") keyV1 = row.value || "";
    else if (row.key === "UNIPILE_BASE_V2_URL") base = row.value || "";
  }
  const key = keyV2 || keyV1;
  if (!key) return null;
  base = (base || "https://api.unipile.com/v2").replace(/\/+$/, "");
  _cachedKey = { key, base, at: now };
  return { key, base };
}

/**
 * Fetch every file attachment on a Unipile LinkedIn message and upload it to
 * Storage. Returns the array to write into `messages.attachments` (empty when
 * there are none, or on any failure — attachment errors never block the
 * message insert).
 */
export async function fetchAndUploadLinkedinAttachments(
  supabase: any,
  messageData: any,
  conversationId: string,
  logger: MiniLogger = {},
): Promise<StoredAttachment[]> {
  const atts: any[] = Array.isArray(messageData?.attachments) ? messageData.attachments : [];
  if (atts.length === 0) return [];

  const creds = await resolveV2Creds(supabase);
  if (!creds) {
    logger.warn?.("linkedin-attachments: no Unipile v2 key in app_settings — skipping");
    return [];
  }

  const msgId = String(messageData?.id || messageData?.message_id || "unknown");
  const safeMsgId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);

  const result: StoredAttachment[] = [];

  for (const att of atts) {
    try {
      const name = String(att?.filename || att?.name || `attachment-${att?.id || "file"}`);
      const mime = (att?.mimetype || att?.mime_type || "application/octet-stream") as string;
      const size: number | null = att?.file_size ?? att?.size ?? null;

      if (size && size > MAX_ATTACHMENT_BYTES) {
        logger.warn?.("Skipping oversized LinkedIn attachment", { name, size });
        continue;
      }

      // Prefer the absolute URL Unipile hands us (it embeds the acc id). It only
      // resolves with the API key header.
      const url: string | null = typeof att?.url === "string" && att.url.startsWith("http") ? att.url : null;
      if (!url) {
        logger.warn?.("LinkedIn attachment missing a fetchable URL — skipping", { name, id: att?.id });
        continue;
      }

      const resp = await fetch(url, {
        headers: { "X-API-KEY": creds.key, Accept: "*/*" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!resp.ok) {
        logger.warn?.("Could not download LinkedIn attachment", { name, status: resp.status });
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength === 0) continue;
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
        logger.warn?.("Downloaded LinkedIn attachment exceeds size cap — skipping", { name, bytes: buf.byteLength });
        continue;
      }

      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `inbound/${conversationId}/${safeMsgId}/${safeName}`;

      const { error: upErr } = await supabase.storage
        .from(MESSAGE_ATTACHMENTS_BUCKET)
        .upload(storagePath, buf, { contentType: mime, upsert: true });
      if (upErr) {
        logger.warn?.("Failed to upload LinkedIn attachment", { name, error: upErr.message });
        continue;
      }

      result.push({
        name,
        storage_path: storagePath,
        mime_type: mime || null,
        size: size ?? buf.byteLength,
      });
    } catch (err: any) {
      logger.warn?.("Error processing LinkedIn attachment", { error: err?.message });
    }
  }

  if (result.length > 0) logger.info?.("LinkedIn attachments uploaded", { conversationId, count: result.length });
  return result;
}
