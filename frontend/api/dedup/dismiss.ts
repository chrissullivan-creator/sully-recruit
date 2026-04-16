import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/dedup/dismiss
 *
 * Dismisses a duplicate candidate pair.
 * Body: { duplicatePairId: string }
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

  if (token === serviceKey) {
    // Service key auth — allowed
  } else if (token) {
    const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  } else {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { duplicatePairId } = req.body;

    if (!duplicatePairId) {
      return res.status(400).json({ error: "Missing required field: duplicatePairId" });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    const { error: updateErr } = await supabaseAdmin
      .from("duplicate_candidates")
      .update({ status: "dismissed" })
      .eq("id", duplicatePairId);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("Dismiss duplicate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
