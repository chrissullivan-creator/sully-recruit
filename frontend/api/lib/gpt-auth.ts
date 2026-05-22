import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Auth for the "Ask Joe Send Outs Emerald" ChatGPT GPT Action.
 *
 * The GPT calls our Vercel API with `Authorization: Bearer <ASK_JOE_SENDOUT>`.
 * That static API key is the ONLY thing the GPT carries. The Supabase
 * service-role key never leaves the server.
 *
 * Set ASK_JOE_SENDOUT in Vercel: a long random string you paste into
 * the GPT Action config under "Authentication → API Key → Bearer".
 *
 * Returns true on success. On failure, writes the 401/500 response and
 * returns false so the caller can `if (!ok) return;`.
 */
export function requireGptAuth(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.ASK_JOE_SENDOUT;
  if (!expected) {
    res.status(500).json({ error: "Server misconfigured: ASK_JOE_SENDOUT not set" });
    return false;
  }

  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Shared CORS preflight handler. ChatGPT calls server-to-server, so CORS
 * isn't strictly required, but it makes manual curl/Postman testing
 * easier and doesn't open any extra attack surface (auth is still enforced).
 */
export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
