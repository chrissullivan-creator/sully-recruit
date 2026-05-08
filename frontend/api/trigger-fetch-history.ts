import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to trigger the fetch-entity-history Trigger.dev task.
 * Called from Contacts page "Fetch History" dropdown action.
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

    const handle = await tasks.trigger("fetch-entity-history", { contact_id });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger fetch-history error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
