import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-sync-outlook
 *
 * Fires `outlook/sync-requested` into Inngest. Called from Tasks page
 * "Sync Outlook" button.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { ids } = await inngest.send({
      // Idempotency: a flurry of clicks dedupes to one run per minute.
      // Calendar sync is multi-account (~10s) so one-per-minute is the
      // right cadence anyway.
      id: `outlook-sync-${Math.floor(Date.now() / 60000)}`,
      name: "outlook/sync-requested",
      data: {},
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger outlook/sync-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
