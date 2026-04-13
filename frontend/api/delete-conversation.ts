import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/delete-conversation
 *
 * Deletes a conversation and its messages (via ON DELETE CASCADE).
 * Uses service role to bypass RLS (conversations created by backfill/webhook
 * have NULL owner_id and cannot be deleted via the frontend client).
 *
 * Body: { conversation_id: string }
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

  const { conversation_id } = req.body || {};
  if (!conversation_id) return res.status(400).json({ error: "Missing conversation_id" });

  try {
    const { error } = await supabase
      .from("conversations")
      .delete()
      .eq("id", conversation_id);
    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("Delete conversation failed:", err);
    return res.status(500).json({ error: err.message || "Delete failed" });
  }
}
