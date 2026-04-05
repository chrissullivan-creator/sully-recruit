import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger the run-nudge-check Trigger.dev task.
 * Called from Tasks page to manually run the stagnation nudge check.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const handle = await tasks.trigger("run-nudge-check", {});

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger nudge-check error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
