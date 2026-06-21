import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/backfill-linkedin-deep
 *
 * Fires a one-shot DEEP LinkedIn backfill — a wider window than the routine
 * 3-day v2 sweep (backfill-linkedin-messages-v2) — to recover older messages
 * the routine cron can't reach. Use it after reconnecting a LinkedIn seat to
 * pull back Recruiter InMail (and classic DMs) missed while the seat's Unipile
 * session was stalled.
 *
 * Body (all optional): { lookbackDays = 45, maxPages = 6, accountId }
 *   - accountId: restrict to a single integration_accounts.id (e.g. Chris's
 *     Recruiter seat). Omit to sweep every active v2 LinkedIn seat.
 *
 * Auth: Bearer Supabase JWT (logged-in recruiter) or service-role key.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return; // response already sent

  const { lookbackDays, maxPages, accountId } = req.body ?? {};
  try {
    const { ids } = await inngest.send({
      name: "ops/backfill-linkedin-deep.requested",
      data: {
        lookbackDays: Number(lookbackDays) || 45,
        maxPages: Number(maxPages) || 6,
        ...(accountId ? { accountId: String(accountId) } : {}),
      },
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("backfill-linkedin-deep error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
