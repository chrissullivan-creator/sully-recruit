import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";
import { safeEqual } from "../lib/safe-compare.js";

/**
 * One-shot admin endpoint to kick off `reclassify-linkedin-chats-once`.
 *
 *   curl -X POST https://<vercel-app>/api/admin/trigger-reclassify-linkedin \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"force": true, "limit": 5000}'
 *
 * Re-pulls every LinkedIn conversation from Unipile v2 and re-stamps
 * `conversations.channel` + `content_type`. Use after dedup/cleanup to
 * fix mis-bucketed rows (e.g. Recruiter InMails landing in the Classic
 * tab because content_type was null at insert time).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" });
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(got, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const force = req.body?.force === true;
  const limit = Number(req.body?.limit) || 5000;

  try {
    const { ids } = await inngest.send({
      name: "ops/reclassify-linkedin-chats.requested",
      data: { force, limit },
    });
    return res.status(200).json({ ok: true, dispatched: true, eventId: ids[0], force, limit });
  } catch (err: any) {
    console.error("trigger-reclassify-linkedin admin endpoint error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
