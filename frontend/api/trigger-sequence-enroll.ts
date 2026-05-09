import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk/v3";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Initialize a sequence_enrollments row by pre-scheduling all its
 * step_logs. Routes to whichever engine owns the sequence:
 *
 *   - sequences.engine='inngest' (default for new sequences post-cutover)
 *     → inngest.send("sequence/enrollment-init.requested")
 *   - sequences.engine='trigger' (legacy fallback)
 *     → tasks.trigger("sequence-enrollment-init")
 *
 * Both engines call the same `runSequenceEnrollmentInit` body — the
 * dispatch only differs in which orchestrator drives retries +
 * concurrency control.
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

    // Read the sequence's engine column to decide where to dispatch.
    // engine column was added in migration 20260509000000; cast until
    // the weekly types-regen workflow catches up.
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: seq } = await (supabase as any)
      .from("sequences")
      .select("engine")
      .eq("id", sequence_id)
      .maybeSingle();
    const engine = (seq?.engine || "trigger") as "trigger" | "inngest";

    const data = {
      enrollmentId: enrollment_id,
      sequenceId: sequence_id,
      candidateId: candidate_id || undefined,
      contactId: contact_id || undefined,
      enrolledBy: enrolled_by,
      accountId: account_id || undefined,
    };

    if (engine === "inngest") {
      // Idempotency: a duplicate POST (e.g. EnrollDialog retrying on a
      // 502) dedupes server-side because the event id is keyed on the
      // enrollmentId.
      const { ids } = await inngest.send({
        id: `enrollment-init-${enrollment_id}`,
        name: "sequence/enrollment-init.requested",
        data,
      });
      return res.status(200).json({ triggered: true, engine: "inngest", id: ids[0] });
    }

    const handle = await tasks.trigger("sequence-enrollment-init", data);
    return res.status(200).json({ triggered: true, engine: "trigger", id: handle.id });
  } catch (err: any) {
    console.error("Trigger sequence-enrollment-init error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
