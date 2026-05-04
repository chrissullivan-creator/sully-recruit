/**
 * Cloudflare Email Worker — resumes inbox forwarder.
 *
 * Bound to: resumes_emeraldrecruit@sullyrecruit.app (and any other
 * resumes-inbox alias on Cloudflare Email Routing).
 *
 * Flow per inbound email:
 *   1. parse the raw RFC822 with postal-mime
 *   2. POST sender + attachments as JSON to /api/webhooks/cloudflare-email
 *      with a shared secret in x-cloudflare-secret
 *
 * Setup:
 *   - Cloudflare dashboard → Workers & Pages → Create → "Email Worker"
 *   - Paste this file as the worker code
 *   - In the worker's Settings → Variables:
 *       CLOUDFLARE_EMAIL_WEBHOOK_URL    = https://www.sullyrecruit.app/api/webhooks/cloudflare-email
 *       CLOUDFLARE_EMAIL_WEBHOOK_SECRET = <random string, must match Vercel CLOUDFLARE_EMAIL_WEBHOOK_SECRET env>
 *   - In package.json (or Cloudflare's "Bindings" / npm install for Workers):
 *       npm install postal-mime
 *   - Email Routing → Routes → set the destination address's action to
 *     "Send to Worker" → pick this Worker.
 */

import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    try {
      const raw = await streamToString(message.raw);
      const parsed = await PostalMime.parse(raw);

      const senderEmail = (parsed.from?.address || '').toLowerCase();
      const senderName = parsed.from?.name || '';
      const recipientEmail = (message.to || '').toLowerCase();
      const subject = parsed.subject || '';
      const messageId = parsed.messageId || `cf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      const attachments = (parsed.attachments || []).map((att) => ({
        filename: att.filename || 'unnamed',
        contentType: att.mimeType || 'application/octet-stream',
        size: att.content?.byteLength ?? 0,
        contentBase64: bufferToBase64(att.content),
      }));

      const resp = await fetch(env.CLOUDFLARE_EMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cloudflare-secret': env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          sender_email: senderEmail,
          sender_name: senderName,
          recipient_email: recipientEmail,
          subject,
          message_id: messageId,
          attachments,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error('Webhook returned non-OK', resp.status, text);
        // Reject so Cloudflare retries.
        message.setReject(`webhook ${resp.status}`);
      }
    } catch (err) {
      console.error('Email worker failed', err);
      message.setReject(`worker error: ${err.message}`);
    }
  },
};

async function streamToString(stream) {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder('utf-8').decode(merged);
}

function bufferToBase64(buf) {
  if (!buf) return '';
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
