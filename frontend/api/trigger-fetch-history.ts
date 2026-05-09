import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the
 * `messages/fetch-entity-history.requested` Inngest event. Called from
 * the Contacts page "Fetch History" dropdown action.
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
      name: "messages/fetch-entity-history.requested",
      data: { contact_id },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger fetch-history error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
