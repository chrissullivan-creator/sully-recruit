import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger the sync-activity-timestamps Trigger.dev task.
 * Called from CandidateDetail page to recalculate activity timestamps.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { entity_type, entity_id } = req.body;

    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: "Missing required fields: entity_type, entity_id" });
    }

    const handle = await tasks.trigger("sync-activity-timestamps", {
      entity_type,
      entity_id,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger sync-activity error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
