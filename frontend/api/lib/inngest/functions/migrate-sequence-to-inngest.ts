import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";

/**
 * Per-sequence cutover. Phase 1: NO-OP — this handler exists so the fan-out
 * from `bulk-migrate-sequences` lands somewhere and the wiring can be
 * end-to-end tested against the Inngest dashboard. It does not flip
 * `engine` and does not cancel any Trigger.dev step_logs. Phase 2 fills
 * the body in.
 *
 * The shape of the future flip is sketched below as comments so the next
 * PR knows exactly which steps to fill in:
 *
 *   1. `flip-engine`            UPDATE sequences SET engine='inngest'
 *   2. `cancel-pending-logs`    UPDATE sequence_step_logs SET status='cancelled'
 *                               WHERE enrollment in active enrollments AND
 *                                     status in (scheduled, in_flight,
 *                                                pending_connection)
 *   3. `fan-out-runs`           step.sendEvent for each active enrollment →
 *                               sequence/run.requested
 *
 * The `enrolledBy` resolution rule (caller > sender_user_id > created_by)
 * already lives here so phase 2 just plugs it into the run payload.
 */
export const migrateSequenceToInngest = inngest.createFunction(
  { id: "migrate-sequence-to-inngest", name: "Migrate one sequence to Inngest" },
  { event: "infra/migrate-sequence-to-inngest.requested" },
  async ({ event, step, logger }) => {
    const { sequenceId, enrolledBy: callerEnrolledBy } = event.data;

    const sequence = await step.run("load-sequence", async () => {
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );
      // engine column is added by migration 20260509000000; cast until the
      // weekly types-regen workflow catches up.
      const { data, error } = await (supabase as any)
        .from("sequences")
        .select("id, name, engine, status, sender_user_id, created_by")
        .eq("id", sequenceId)
        .single();
      if (error) throw new Error(`load_sequence: ${error.message}`);
      return data;
    });

    if (!sequence || sequence.status !== "active" || sequence.engine !== "trigger") {
      logger.info("Sequence not eligible — skipping", {
        sequenceId,
        status: sequence?.status,
        engine: sequence?.engine,
      });
      return { action: "skipped", reason: "not_eligible" };
    }

    const resolvedEnrolledBy =
      callerEnrolledBy ?? sequence.sender_user_id ?? sequence.created_by;

    if (!resolvedEnrolledBy) {
      logger.warn("No enrolledBy resolvable — sequence has no sender_user_id or created_by", {
        sequenceId,
      });
      return { action: "skipped", reason: "no_enrolled_by" };
    }

    logger.info("Phase 1 — would migrate sequence (no-op)", {
      sequenceId,
      sequenceName: sequence.name,
      resolvedEnrolledBy,
    });

    return {
      action: "phase1_noop",
      sequenceId,
      resolvedEnrolledBy,
    };
  },
);
