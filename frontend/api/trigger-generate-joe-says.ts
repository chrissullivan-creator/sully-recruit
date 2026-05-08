import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to trigger the generate-joe-says Trigger.dev task.
 * Called from CandidateDetail / ContactDetail "Generate Joe Says" button,
 * and also from Supabase database triggers when notes are inserted.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { entityId, entityType } = req.body;

    if (!entityId || !entityType) {
      return res.status(400).json({ error: "Missing required fields: entityId, entityType" });
    }

    if (entityType !== "candidate" && entityType !== "contact") {
      return res.status(400).json({ error: "entityType must be 'candidate' or 'contact'" });
    }

    const handle = await tasks.trigger("generate-joe-says", {
      entityId,
      entityType,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger generate-joe-says error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
