import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * Verifies the request bears a valid Supabase JWT (logged-in user) or the
 * service role key as a Bearer token. On failure, writes the 401/500 response
 * and returns null so the caller can `return` immediately.
 *
 * Usage:
 *   const auth = await requireAuth(req, res);
 *   if (!auth) return;        // response already sent
 *   const { userId } = auth;  // null if service-role
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
): Promise<{ userId: string | null } | null> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!serviceKey || !supabaseUrl || !anonKey) {
    res.status(500).json({ error: "Server misconfigured" });
    return null;
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  // Service-role key grants full access (used by internal callers / cron).
  if (token === serviceKey) {
    return { userId: null };
  }

  const client = createClient(supabaseUrl, anonKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { userId: data.user.id };
}
