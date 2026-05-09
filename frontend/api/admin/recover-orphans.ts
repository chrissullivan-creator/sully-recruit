import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";

/**
 * One-shot admin endpoint to kick off `recover-orphan-resumes`.
 *
 *   curl -X POST https://<vercel-app>/api/admin/recover-orphans \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"limit": 500, "since": "2025-01-01"}'
 *
 * Each call sends one `ops/recover-orphan-resumes.requested` event.
 * The Inngest function does the storage scan, creates stubs +
 * resumes rows, and fans out `ai/resume-ingestion.requested` per
 * orphan. Re-runnable — the underlying RPC `list_orphan_resume_files`
 * already filters out files that have a resumes row.
 *
 * Auth: same Bearer SUPABASE_SERVICE_ROLE_KEY pattern as
 * cutover-finalize. Anyone with this key already has full DB access.
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
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const limit = Number(req.body?.limit) || 500;
  const since = (req.body?.since as string) || "2025-01-01";

  try {
    const { ids } = await inngest.send({
      name: "ops/recover-orphan-resumes.requested",
      data: { limit, since },
    });
    return res.status(200).json({ ok: true, dispatched: true, eventId: ids[0], limit, since });
  } catch (err: any) {
    console.error("recover-orphans admin endpoint error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
