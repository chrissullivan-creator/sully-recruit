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
 *
 * Note on env: server-side Vercel functions don't see VITE_* vars by default
 * (those are baked into the client build). We try the unprefixed names first,
 * fall through to VITE_* if the project exposes them server-side too, and
 * finally use the service key client to verify the token. `auth.getUser(token)`
 * only does cryptographic signature verification — it doesn't depend on RLS,
 * so the service-key client is fine for that purpose.
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
): Promise<{ userId: string | null } | null> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL;

  if (!serviceKey || !supabaseUrl) {
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

  const verifierKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    serviceKey;

  const client = createClient(supabaseUrl, verifierKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { userId: data.user.id };
}
