import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * POST /api/dedup/scan
 *
 * Triggers the scan-duplicate-candidates Trigger.dev task.
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
    const handle = await tasks.trigger("scan-duplicate-candidates", {});

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger scan-duplicate-candidates error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
