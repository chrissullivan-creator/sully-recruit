/**
 * Cloudflare Email Worker — resumes inbox relay.
 *
 * Bound to: resumes_emeraldrecruit@sullyrecruit.app (and any other
 * resumes-inbox alias on Cloudflare Email Routing).
 *
 * Streams the raw RFC822 directly to the Vercel webhook — no MIME
 * parsing, no buffering, no npm deps.
 *
 * Setup:
 *   1. Cloudflare → Workers & Pages → Create Worker (Hello World)
 *   2. Paste this file's contents → Deploy
 *   3. Settings → Variables and Secrets:
 *        CLOUDFLARE_EMAIL_WEBHOOK_URL    = https://www.sullyrecruit.app/api/webhooks/cloudflare-email
 *        CLOUDFLARE_EMAIL_WEBHOOK_SECRET = <secret> (mark Secret)
 *      Both must match the Vercel side
 *      (env var or app_settings.CLOUDFLARE_EMAIL_WEBHOOK_SECRET).
 *   4. Email Routing → Routing rules → edit your inbox alias →
 *      Action: "Send to Worker" → pick this worker.
 */

export default {
  async email(message, env, ctx) {
    // Fail fast with a useful log if the worker isn't fully configured.
    if (!env || !env.CLOUDFLARE_EMAIL_WEBHOOK_URL) {
      console.error('Worker missing CLOUDFLARE_EMAIL_WEBHOOK_URL env var');
      message.setReject('worker not configured');
      return;
    }
    if (!env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET) {
      console.error('Worker missing CLOUDFLARE_EMAIL_WEBHOOK_SECRET env var');
      message.setReject('worker not configured');
      return;
    }

    try {
      // Drain the raw RFC822 stream into an ArrayBuffer so the upstream
      // gets a proper Content-Length header. Some Vercel/Node bodyParser
      // configurations choke on a streamed body without a length.
      const raw = await new Response(message.raw).arrayBuffer();

      const resp = await fetch(env.CLOUDFLARE_EMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'x-cloudflare-secret': env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
          'x-mail-from': message.from || '',
          'x-mail-to': message.to || '',
        },
        body: raw,
      });

      if (resp.ok) return;

      // Read the response body for the worker logs — Cloudflare truncates
      // logs but at least the status code + first chars of error reach us.
      let detail = '';
      try { detail = (await resp.text()).slice(0, 500); } catch {}
      console.error(`Webhook ${resp.status}: ${detail}`);

      // 4xx are permanent (bad payload, auth) — bounce. 5xx and network
      // errors get re-thrown so Cloudflare retries.
      if (resp.status >= 400 && resp.status < 500) {
        message.setReject(`webhook ${resp.status}`);
      } else {
        throw new Error(`webhook ${resp.status}`);
      }
    } catch (err) {
      console.error('Email worker exception', err && err.stack || err);
      throw err;
    }
  },
};
