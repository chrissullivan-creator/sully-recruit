import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-fetch-history
 * body: { contact_id: string }
 *
 * Fires `entity/history-requested` into Inngest. The Inngest function
 * (frontend/src/inngest/functions/fetch-entity-history.ts) wraps
 * `runFetchEntityHistory` from the legacy Trigger.dev file.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { contact_id } = req.body;
    if (!contact_id) {
      return res.status(400).json({ error: "Missing required field: contact_id" });
    }

    const { ids } = await inngest.send({
      id: `fetch-history-${contact_id}-${Math.floor(Date.now() / 1000)}`,
      name: "entity/history-requested",
      data: { contact_id },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger entity/history-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
