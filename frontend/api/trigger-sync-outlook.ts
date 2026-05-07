import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { requireAuth } from "./lib/auth";

/**
 * Vercel serverless function to trigger the sync-outlook-events Trigger.dev task.
 * Called from Tasks page to sync Outlook calendar events.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const handle = await tasks.trigger("sync-outlook-events", {});

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger sync-outlook error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
