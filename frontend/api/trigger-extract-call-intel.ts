import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the
 * `messages/extract-call-intel.requested` Inngest event.
 *
 * Called fire-and-forget by the Calls page after a recruiter logs a
 * call (or links an existing call to a candidate). The Inngest function
 * pulls the notes off the call_log row and runs Joe extraction, then
 * applies the same field updates the Deepgram path applies for
 * transcribed calls.
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
      name: "messages/extract-call-intel.requested",
      data: { callLogId: id },
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger extract-call-intel error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
