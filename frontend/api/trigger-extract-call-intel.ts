import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-extract-call-intel
 * body: { callLogId | call_log_id: string }
 *
 * Fires `call/intel-requested` into Inngest. The Inngest function
 * (frontend/src/inngest/functions/extract-call-intel.ts) wraps
 * `runExtractManualCallIntel` from the legacy Trigger.dev file.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { call_log_id, callLogId } = req.body ?? {};
    const id = callLogId ?? call_log_id;
    if (!id) {
      return res.status(400).json({ error: "Missing call_log_id" });
    }

    const { ids } = await inngest.send({
      // Idempotency: same call log won't kick off two intel extractions
      // within the same second (typical double-click).
      id: `call-intel-${id}-${Math.floor(Date.now() / 1000)}`,
      name: "call/intel-requested",
      data: { callLogId: id },
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger call/intel-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
