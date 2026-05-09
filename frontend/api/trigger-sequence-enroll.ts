import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Initialize a `sequence_enrollments` row by firing
 * `sequence/enrollment-init.requested` so the Inngest function
 * pre-schedules every `sequence_step_logs` row this enrollment will
 * need. Idempotent on the enrollment id — a duplicate POST (e.g.
 * EnrollDialog retrying on a 502) dedupes server-side because the
 * event id is keyed on `enrollment-init-{enrollmentId}`.
 *
 * Post-Trigger.dev cutover: every sequence is `engine='inngest'`. The
 * old Trigger.dev fallback was deleted along with the SDK.
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

    const { ids } = await inngest.send({
      id: `enrollment-init-${enrollment_id}`,
      name: "sequence/enrollment-init.requested",
      data: {
        enrollmentId: enrollment_id,
        sequenceId: sequence_id,
        candidateId: candidate_id || undefined,
        contactId: contact_id || undefined,
        enrolledBy: enrolled_by,
        accountId: account_id || undefined,
      },
    });
    return res.status(200).json({ triggered: true, engine: "inngest", id: ids[0] });
  } catch (err: any) {
    console.error("Trigger sequence-enrollment-init error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
