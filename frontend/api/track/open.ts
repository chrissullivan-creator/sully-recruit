/**
 * GET /api/track/open?id=<stepLogId>
 *
 * Returns a 1×1 transparent GIF and (best-effort) increments the
 * matching sequence_step_logs row's opened_at + open_count via the
 * `increment_step_log_open` RPC.
 *
 * Migrated to **Vercel Edge runtime** as part of the Inngest migration.
 * The rationale: this endpoint gets hit thousands of times a day from
 * many geographic regions whenever recipients open a tracked email.
 * Edge runs on Cloudflare's global network, drops ~150ms of latency
 * per hit, has no cold start, and is dirt cheap at scale.
 *
 * Edge-runtime caveats:
 * - Native Web APIs only (Request/Response, fetch, Uint8Array). No
 *   Buffer, no Node fs, no @supabase/supabase-js (it works on Edge but
 *   bundles ~150kB; we just call the REST endpoint directly with fetch).
 * - No process.env in some Edge configs — Vercel Edge does support it
 *   for the env vars defined in the project, which we use here.
 *
 * Public — auth via the unguessable step_log UUID. Tracking failures
 * must never block the pixel response (caller is a mail client; we're
 * already past the threshold of "user has seen the email").
 */
export const config = { runtime: "edge" };

// 1×1 transparent GIF (decoded once at module load; the binary is tiny).
const TRANSPARENT_GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const TRANSPARENT_GIF = b64ToBytes(TRANSPARENT_GIF_B64);

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();

  // Fire-and-forget: never await; the pixel must respond fast.
  // Edge runtime supports `waitUntil` via the Cloudflare/Vercel context
  // but using `Promise.resolve().then(...)` is fine for a low-stakes
  // best-effort write.
  if (id) {
    Promise.resolve().then(async () => {
      try {
        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceKey) return;
        // Atomic increment via Postgres RPC — mail clients fire the
        // pixel many times concurrently (preview, full view, image
        // proxy), and a read-modify-write here would drop opens.
        const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_step_log_open`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_id: id }),
        });
        if (!resp.ok) {
          // Visibility — keep parity with the Node version's logging.
          // Pixel response is already in flight so user impact is zero.
          // eslint-disable-next-line no-console
          console.error("track/open: increment_step_log_open RPC failed", {
            id, status: resp.status, body: (await resp.text()).slice(0, 200),
          });
        }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("track/open: unexpected error", { id, message: err?.message });
      }
    });
  }

  // BodyInit accepts ArrayBuffer; the underlying Uint8Array buffer is
  // an ArrayBuffer so this is just a type narrowing for older lib defs.
  return new Response(TRANSPARENT_GIF.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
