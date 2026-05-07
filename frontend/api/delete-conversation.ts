import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/delete-conversation
 *
 * Deletes one or many conversations and their messages (via ON DELETE
 * CASCADE). Service role bypasses RLS — conversations created by
 * backfill/webhook have NULL owner_id and can't be deleted via the
 * frontend client.
 *
 * Body (either form):
 *   { conversation_id: string }              // single
 *   { conversation_ids: string[] }           // bulk
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { conversation_id, conversation_ids } = req.body || {};
  // Accept both shapes; dedupe + drop falsy entries.
  const ids = Array.from(
    new Set(
      Array.isArray(conversation_ids)
        ? conversation_ids
        : conversation_id ? [conversation_id] : [],
    ),
  ).filter(Boolean) as string[];
  if (ids.length === 0) return res.status(400).json({ error: "Missing conversation_id(s)" });

  try {
    const { error, count } = await supabase
      .from("conversations")
      .delete({ count: "exact" })
      .in("id", ids);
    if (error) throw error;

    return res.status(200).json({ success: true, deleted: count ?? ids.length });
  } catch (err: any) {
    console.error("Delete conversation failed:", err);
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
}
