import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the `ai/joe-says.requested`
 * Inngest event. Called from CandidateDetail / ContactDetail "Generate
 * Joe Says" button, and from Supabase DB triggers when notes are inserted.
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

    const { ids } = await inngest.send({
      name: "ai/joe-says.requested",
      data: { entityId, entityType },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger generate-joe-says error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
