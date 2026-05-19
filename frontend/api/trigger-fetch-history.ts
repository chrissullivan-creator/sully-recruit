import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the
 * `messages/fetch-entity-history.requested` Inngest event. Accepts
 * either the legacy `{ contact_id }` shape (Contacts list dropdown) or
 * the unified `{ entity_id, entity_type }` shape (CandidateDetail /
 * ContactDetail "Fetch History" menu items). The Inngest function
 * fetch-entity-history accepts both payloads internally.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { contact_id, entity_id, entity_type } = req.body ?? {};

    let data: Record<string, unknown>;
    if (entity_id && entity_type) {
      if (entity_type !== "candidate" && entity_type !== "contact") {
        return res.status(400).json({ error: "entity_type must be 'candidate' or 'contact'" });
      }
      data = { entity_id, entity_type };
    } else if (contact_id) {
      data = { contact_id };
    } else {
      return res.status(400).json({
        error: "Missing required fields: either { contact_id } or { entity_id, entity_type }",
      });
    }

    const { ids } = await inngest.send({
      name: "messages/fetch-entity-history.requested",
      data,
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger fetch-history error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
