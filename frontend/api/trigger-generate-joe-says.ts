import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire `joe/says-requested` into Inngest.
 *
 * Called from CandidateDetail / ContactDetail "Generate Joe Says"
 * button, plus Supabase DB triggers on notes inserts. Migrated to
 * Inngest as part of Phase 4 — the Inngest function (in
 * frontend/src/inngest/functions/generate-joe-says.ts) is a thin
 * wrapper around `runGenerateJoeSays`, the same helper the Trigger.dev
 * task wraps. One source of truth for the logic.
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
      // Idempotency: a flurry of clicks on "Generate Joe Says" within
      // a few seconds dedupes to one run per entity per second.
      id: `joe-says-${entityId}-${Math.floor(Date.now() / 1000)}`,
      name: "joe/says-requested",
      data: { entityId, entityType },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger joe/says-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
