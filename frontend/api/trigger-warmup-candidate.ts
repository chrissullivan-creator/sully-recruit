import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger LinkedIn candidate warmup.
 * Engages with a candidate's recent posts before outreach.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { candidate_id, user_id, account_id, max_engagements } = req.body;

    if (!candidate_id) {
      return res.status(400).json({ error: "Missing required field: candidate_id" });
    }

    const handle = await tasks.trigger("warmup-candidate", {
      candidate_id,
      user_id,
      account_id,
      max_engagements,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger warmup-candidate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
