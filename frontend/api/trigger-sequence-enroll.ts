import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * Routes a freshly-inserted sequence_enrollments row to whichever
 * engine owns that sequence's runs.
 *
 * Reads `sequences.engine`:
 *   - 'trigger' (default) → tasks.trigger("sequence-enrollment-init", …)
 *   - 'inngest'           → inngest.send("sequence/enrolled", …)
 *
 * The two engines coexist during the migration window. New sequences
 * default to 'trigger' until manually flipped; existing enrollments
 * keep finishing on whichever engine they started on.
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

    // Look up which engine owns this sequence. We use the service-role
    // key here intentionally — the read is gated by an authenticated
    // route, and the column is not user-controlled (the sequence's
    // engine is set by an admin / migration, not the recruiter
    // creating an enrollment).
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .select("engine")
      .eq("id", sequence_id)
      .maybeSingle();
    if (seqErr) {
      console.error("Failed to read sequence engine:", seqErr.message);
      return res.status(500).json({ error: seqErr.message });
    }
    const engine = (seq?.engine || "trigger") as "trigger" | "inngest";

    if (engine === "inngest") {
      const { ids } = await inngest.send({
        // enrollmentId in the event id makes it idempotent — a duplicate
        // POST to this route (e.g. the EnrollDialog retrying on a 502)
        // doesn't double-fire the workflow because Inngest dedupes.
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
      return res.status(200).json({ triggered: true, engine: "inngest", id: ids[0] });
    }

    const handle = await tasks.trigger("sequence-enrollment-init", {
      enrollmentId: enrollment_id,
      sequenceId: sequence_id,
      candidateId: candidate_id || undefined,
      contactId: contact_id || undefined,
      enrolledBy: enrolled_by,
      accountId: account_id || undefined,
    });

    return res.status(200).json({ triggered: true, engine: "trigger", id: handle.id });
  } catch (err: any) {
    console.error("Trigger sequence-enrollment-init error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
