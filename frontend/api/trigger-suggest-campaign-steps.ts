import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger AI campaign step generation.
 * Replaces the Supabase edge function with a Trigger.dev task for
 * better retry/monitoring.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { campaignName, campaignChannel, campaignDescription } = req.body;

    if (!campaignName) {
      return res.status(400).json({ error: "Missing required field: campaignName" });
    }

    const handle = await tasks.triggerAndPoll("suggest-campaign-steps", {
      campaignName,
      campaignChannel: campaignChannel || "email",
      campaignDescription,
    }, { pollIntervalMs: 500 });

    return res.status(200).json(handle.output);
  } catch (err: any) {
    console.error("Trigger suggest-campaign-steps error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
