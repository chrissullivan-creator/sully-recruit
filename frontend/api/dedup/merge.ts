import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * POST /api/dedup/merge
 *
 * Triggers the merge-candidates Trigger.dev task.
 * Body: { survivorId: string, mergedId: string, mergedBy?: string }
 * Auth: Bearer token must match SUPABASE_SERVICE_ROLE_KEY.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Authenticate with service role key
  const authHeader = req.headers.authorization;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey) {
    return res.status(500).json({ error: "Server misconfigured: missing SUPABASE_SERVICE_ROLE_KEY" });
  }

  const token = authHeader?.replace("Bearer ", "");
  if (token !== serviceKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { survivorId, mergedId, mergedBy } = req.body;

    if (!survivorId || !mergedId) {
      return res.status(400).json({ error: "Missing required fields: survivorId, mergedId" });
    }

    if (survivorId === mergedId) {
      return res.status(400).json({ error: "survivorId and mergedId must be different" });
    }

    const handle = await tasks.trigger("merge-candidates", {
      survivorId,
      mergedId,
      mergedBy,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger merge-candidates error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
