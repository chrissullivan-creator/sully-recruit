import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the
 * `ops/sync-outlook-events.requested` Inngest event. Called from the
 * Tasks page "Sync Outlook" button when a recruiter wants to pull
 * calendar events without waiting for the 30-min cron.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { ids } = await inngest.send({
      name: "ops/sync-outlook-events.requested",
      data: {},
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger sync-outlook error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
