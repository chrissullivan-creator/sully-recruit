import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";

/**
 * Per-sequence cutover. Flips `sequences.engine` from `trigger` to `inngest`.
 *
 * Pre-existing scheduled step_logs do not need to be cancelled or re-emitted:
 *   - Trigger.dev sweep (`sequence-sweep-v2`) filters `engine='trigger'`, so
 *     the moment we flip, those rows are invisible to it.
 *   - Inngest sweep (`sequence-sweep`) filters `engine='inngest'`, so the
 *     same rows immediately become claimable on the next 3-minute tick.
 *
 * In-flight rows that Trigger.dev claimed before the flip finish normally
 * inside Trigger.dev (the executor doesn't re-check the engine column —
 * it's already committed to that one send). Stuck-in-flight recovery
 * (>10 min old) is run by both sweeps so a crashed Trigger.dev claim
 * gets reset and picked up by Inngest on the next tick.
 *
 * `enrolledBy` resolution is preserved as audit metadata only — the
 * actual sender_user_id used per-step is read from the sequence row at
 * execution time.
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

    await step.run("flip-engine", async () => {
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );
      const { error } = await (supabase as any)
        .from("sequences")
        .update({ engine: "inngest" })
        .eq("id", sequenceId)
        .eq("engine", "trigger");
      if (error) throw new Error(`flip_engine: ${error.message}`);
    });

    logger.info("Sequence migrated to Inngest", {
      sequenceId,
      sequenceName: sequence.name,
      resolvedEnrolledBy,
    });

    return {
      action: "migrated",
      sequenceId,
      resolvedEnrolledBy,
    };
  },
);
