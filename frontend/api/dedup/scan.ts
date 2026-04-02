import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/dedup/scan
 *
 * Triggers the scan-duplicate-candidates Trigger.dev task.
 * Auth: Supabase JWT (from logged-in user) or service role key.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const token = authHeader?.replace("Bearer ", "");

  if (token !== serviceKey && token) {
    const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  } else if (!token) {
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
