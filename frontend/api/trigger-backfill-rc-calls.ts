import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-backfill-rc-calls
 *
 * Fires the Inngest event `ops/backfill-rc-calls.requested` so the
 * RingCentral backfill function re-fetches calls in a custom window.
 * Combined with the duration-reconciliation logic in poll-rc-calls,
 * this is the path for recovering historical long calls that were
 * stranded under the old 10-min lookback.
 *
 * Body: { lookback_minutes: number }   // e.g. 525600 for ~365 days
 * Auth: Supabase JWT (any signed-in user)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { lookback_minutes } = req.body ?? {};
    const minutes = Number(lookback_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "lookback_minutes (positive number) required" });
    }

    const { ids } = await inngest.send({
      name: "ops/backfill-rc-calls.requested",
      data: { lookback_minutes: minutes },
    });

    return res.status(200).json({ triggered: true, id: ids[0], lookback_minutes: minutes });
  } catch (err: any) {
    console.error("Trigger backfill-rc-calls error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
