import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/track/open?id=<stepLogId>
 *
 * Returns a 1×1 transparent GIF and (best-effort) updates the matching
 * sequence_step_logs row: stamps opened_at on first hit, increments
 * open_count on every hit. Public — auth via the unguessable step log
 * UUID. Tracking failures must never block the pixel response.
 */

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Always send the pixel — caching headers prevent an open-event from being
  // counted multiple times by the same client repaint.
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const id = String(req.query.id || "").trim();

  if (id) {
    // Fire-and-forget: don't await, don't fail the response.
    // Atomic increment via RPC — real mail clients fire the pixel many
    // times concurrently (preview, full view, image proxy), and a
    // read-modify-write here would drop opens.
    (async () => {
      try {
        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceKey) return;
        const supabase = createClient(supabaseUrl, serviceKey);
        await supabase.rpc("increment_step_log_open", { p_id: id });
      } catch {
        // Swallow — the pixel response must never block on tracking.
      }
    })();
  }

  res.status(200).send(TRANSPARENT_GIF);
}
