import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * Fires `sequence/enrolled` into Inngest after a sequence_enrollments
 * row is inserted. The Inngest sequence-run function takes over and
 * walks the enrollment top-to-bottom.
 *
 * Trigger.dev was decommissioned; sequences must be on engine='inngest'.
 * Any sequence still on engine='trigger' returns 409 — the operator
 * must run sequence/migrate-to-inngest.requested first.
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

    // Verify the sequence is on the Inngest engine. Sequences still on
    // engine='trigger' have no dispatcher post-cutover and would freeze.
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: seq } = await supabase
      .from("sequences")
      .select("engine")
      .eq("id", sequence_id)
      .maybeSingle();
    const engine = (seq?.engine || "trigger") as string;
    if (engine !== "inngest") {
      return res.status(409).json({
        error: `sequence ${sequence_id} is on engine='${engine}'. Run inngest.send({ name: "sequence/migrate-to-inngest.requested", data: { sequenceId } }) first.`,
      });
    }

    const { ids } = await inngest.send({
      // enrollmentId in the event id makes it idempotent — a duplicate
      // POST (e.g. EnrollDialog retrying on a 502) doesn't double-fire.
      id: `seq-enrolled-${enrollment_id}`,
      name: "sequence/enrolled",
      data: {
        enrollmentId: enrollment_id,
        sequenceId: sequence_id,
        candidateId: candidate_id || undefined,
        contactId: contact_id || undefined,
        enrolledBy: enrolled_by,
        accountId: account_id || undefined,
      },
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger sequence/enrolled error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
