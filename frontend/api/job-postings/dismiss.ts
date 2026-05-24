import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/job-postings/dismiss
 *
 * Soft-delete one or more company_job_postings. Sets dismissed_at +
 * dismissed_by_user_id. The fetcher's dedup (ON CONFLICT on
 * company_id+external_id) means a dismissed posting won't get
 * resurrected on the next refresh.
 *
 *   Body: { postingIds: string[] }   // up to 200
 *
 * Returns: { dismissed: number }
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  let userId: string | null = null;
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
    userId = user.id;
  }

  const postingIds: string[] = Array.isArray(req.body?.postingIds) ? req.body.postingIds : [];
  if (postingIds.length === 0) return res.status(400).json({ error: "postingIds[] required" });
  if (postingIds.length > 200) return res.status(400).json({ error: "Max 200 per request" });

  const { error: updErr, count } = await supabase
    .from("company_job_postings")
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by_user_id: userId,
    }, { count: "exact" })
    .in("id", postingIds)
    .is("dismissed_at", null);          // don't re-stamp already-dismissed rows
  if (updErr) return res.status(500).json({ error: `dismiss failed: ${updErr.message}` });

  return res.status(200).json({ dismissed: count ?? 0 });
}
