import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * POST /api/trigger-match-job
 * Triggers the match-single-job Trigger.dev task for a specific job.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing required field: jobId" });
    }

    const handle = await tasks.trigger("match-single-job", { jobId });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger match-job error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
