import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { requireAuth } from "./lib/auth.js";

/**
 * Trigger enrollment initialization for the v2 sequence scheduler.
 * Called after inserting a row into sequence_enrollments.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const {
      enrollment_id,
      sequence_id,
      candidate_id,
      contact_id,
      enrolled_by,
      account_id,
    } = req.body;

    if (!enrollment_id || !sequence_id || !enrolled_by) {
      return res
        .status(400)
        .json({ error: "Missing required fields: enrollment_id, sequence_id, enrolled_by" });
    }

    const handle = await tasks.trigger("sequence-enrollment-init", {
      enrollmentId: enrollment_id,
      sequenceId: sequence_id,
      candidateId: candidate_id || undefined,
      contactId: contact_id || undefined,
      enrolledBy: enrolled_by,
      accountId: account_id || undefined,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger sequence-enrollment-init error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
