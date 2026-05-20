import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-reextract-call-intel
 *
 * Fires the Inngest event `ops/reextract-call-intel.requested` so the
 * sweeper re-runs the current (#262) extraction prompt on stored
 * transcripts and back-fills candidate fields from old calls without
 * paying for another Deepgram pass.
 *
 * Body: { batch?: number }   // optional override (default 30)
 * Auth: Supabase JWT (any signed-in user)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const batch = Number(req.body?.batch) || 30;
    const { ids } = await inngest.send({
      name: "ops/reextract-call-intel.requested",
      data: { batch },
    });
    return res.status(200).json({ triggered: true, id: ids[0], batch });
  } catch (err: any) {
    console.error("Trigger reextract-call-intel error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
