import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * POST /api/trigger-llamacloud-migrate
 * Triggers the one-time migration of all existing resume data to LlamaCloud.
 * This uploads all resume chunks to LlamaCloud's managed pipeline for RAG search.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const handle = await tasks.trigger("migrate-to-llamacloud", {});

    return res.status(200).json({
      triggered: true,
      id: handle.id,
      message: "LlamaCloud migration started. Check Trigger.dev dashboard for progress.",
    });
  } catch (err: any) {
    console.error("Trigger llamacloud-migrate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
