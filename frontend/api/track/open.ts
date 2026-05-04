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
    (async () => {
      try {
        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceKey) return;
        const supabase = createClient(supabaseUrl, serviceKey);

        const { data: existing } = await supabase
          .from("sequence_step_logs")
          .select("id, opened_at, open_count")
          .eq("id", id)
          .maybeSingle();

        if (!existing) return;

        const update: Record<string, any> = {
          open_count: (existing.open_count ?? 0) + 1,
        };
        if (!existing.opened_at) {
          update.opened_at = new Date().toISOString();
        }

        await supabase
          .from("sequence_step_logs")
          .update(update)
          .eq("id", id);
      } catch {
        // Swallow — the pixel response must never block on tracking.
      }
    })();
  }

  res.status(200).send(TRANSPARENT_GIF);
}
