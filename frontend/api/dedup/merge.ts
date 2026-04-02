import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/dedup/merge
 *
 * Triggers the merge-candidates Trigger.dev task.
 * Body: { survivorId: string, mergedId: string, mergedBy?: string }
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

  // Check auth: service role key OR valid Supabase JWT
  const token = authHeader?.replace("Bearer ", "");
  let mergedBy: string | undefined;

  if (token === serviceKey) {
    mergedBy = req.body?.mergedBy;
  } else if (token) {
    const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    mergedBy = user.id;
  } else {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { survivorId, mergedId } = req.body;

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
