import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/person-notes
 *
 * Recent recruiter-written notes for a person. Each note row includes
 * the plain-text body (HTML stripped) and the creating user.
 *
 * Body: { person_id: string, limit?: number (default 10, max 30) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const personId = String(req.body?.person_id ?? "").trim();
  if (!personId) return res.status(400).json({ error: "person_id required" });

  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 30);

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data, error } = await supabase
    .from("notes")
    .select("id, note, entity_type, created_by, created_at")
    .eq("entity_id", personId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    person_id: personId,
    count: data?.length ?? 0,
    notes: (data ?? []).map((n: any) => ({
      id: n.id,
      created_at: n.created_at,
      entity_type: n.entity_type,
      created_by: n.created_by,
      body: String(n.note ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500),
    })),
  });
}
