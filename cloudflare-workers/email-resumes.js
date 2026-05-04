/**
 * Cloudflare Email Worker — resumes inbox relay.
 *
 * Bound to: resumes_emeraldrecruit@sullyrecruit.app (and any other
 * resumes-inbox alias on Cloudflare Email Routing).
 *
 * No npm dependencies — paste straight into the Cloudflare dashboard.
 * The Worker just streams the raw RFC822 to the Vercel webhook, which
 * does the MIME parsing, candidate stubbing, and AI parsing fan-out.
 *
 * Setup:
 *   1. Cloudflare → Workers & Pages → Create Worker (Hello World template)
 *   2. Replace the worker code with this file's contents
 *   3. Settings → Variables and Secrets, add:
 *        CLOUDFLARE_EMAIL_WEBHOOK_URL    = https://www.sullyrecruit.app/api/webhooks/cloudflare-email
 *        CLOUDFLARE_EMAIL_WEBHOOK_SECRET = <secret> (mark Secret)
 *      Both must match the values set on the Vercel side
 *      (env var or app_settings).
 *   4. Email Routing → Routing rules → edit your inbox alias →
 *      Action: "Send to Worker" → pick this worker.
 */

export default {
  async email(message, env) {
    try {
      // Pull the raw RFC822 stream into a single Uint8Array. Cloudflare
      // exposes message.raw as a ReadableStream<Uint8Array>.
      const chunks = [];
      const reader = message.raw.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const raw = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { raw.set(c, off); off += c.length; }

      const resp = await fetch(env.CLOUDFLARE_EMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'x-cloudflare-secret': env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
          // Envelope addresses — the Vercel side prefers parsed.from but
          // falls back to these when the From header is missing.
          'x-mail-from': message.from || '',
          'x-mail-to': message.to || '',
        },
        body: raw,
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error('Webhook returned non-OK', resp.status, text);
        // setReject tells Cloudflare to NDR (sender gets a bounce).
        // Use it for permanent failures only; otherwise let CF retry.
        if (resp.status >= 400 && resp.status < 500) {
          message.setReject(`webhook ${resp.status}`);
        } else {
          throw new Error(`webhook ${resp.status}`);
        }
      }
    } catch (err) {
      console.error('Email worker failed', err && err.stack || err);
      // Re-throw so Cloudflare retries on transient failures.
      throw err;
    }
  },
};
