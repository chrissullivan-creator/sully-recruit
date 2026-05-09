import { inngest } from "../client";
import { getSupabaseAdmin } from "../../server/lib/supabase";

/**
 * One-shot bulk migration: for every sequence still on
 * `engine='trigger'`, fan out a `sequence/migrate-to-inngest.requested`
 * event so the per-sequence migration function does its work in
 * parallel.
 *
 * Designed for the post-deploy cutover. Operator fires:
 *
 *   inngest.send({
 *     name: "infra/bulk-migrate-sequences.requested",
 *     data: { enrolledBy: "<operator-uuid-optional>" },
 *   })
 *
 * Each per-sequence migration function pauses → cancels pending
 * step_logs → flips engine='inngest' → resumes → re-fires
 * sequence/enrolled. Idempotent if re-run.
 *
 * `enrolledBy` is the user_id to attribute the new runs to. When
 * omitted, each per-sequence run falls back to the sequence's
 * sender_user_id / created_by.
 */
export const bulkMigrateSequences = inngest.createFunction(
  {
    id: "bulk-migrate-sequences",
    retries: 1,
    triggers: [{ event: "infra/bulk-migrate-sequences.requested" }],
    // Single-flight — no point running this in parallel since each
    // per-sequence migrate is itself per-sequenceId-concurrency=1.
    concurrency: [{ limit: 1 }],
  },
  async ({ event, step, logger }) => {
    const { enrolledBy } = (event.data ?? {}) as { enrolledBy?: string };
    const supabase = getSupabaseAdmin();

    const sequences = await step.run("find-trigger-sequences", async () => {
      const { data, error } = await supabase
        .from("sequences")
        .select("id, name, engine, status")
        .eq("engine", "trigger");
      if (error) throw error;
      return data ?? [];
    });

    if (sequences.length === 0) {
      logger.info("Bulk migrate: no sequences left on engine='trigger'");
      return { dispatched: 0, sequences: [] };
    }

    await step.run("dispatch-per-sequence-migrations", async () => {
      await inngest.send(
        sequences.map((s: any) => ({
          // Distinct id per sequence so each per-sequence migration
          // dedupes correctly against any operator-fired one-offs.
          id: `migrate-seq-${s.id}-${Math.floor(Date.now() / 1000)}`,
          name: "sequence/migrate-to-inngest.requested",
          data: {
            sequenceId: s.id,
            ...(enrolledBy ? { enrolledBy } : {}),
          },
        })),
      );
    });

    logger.info("Bulk migrate dispatched", {
      count: sequences.length,
      sequenceIds: sequences.map((s: any) => s.id),
    });

    return {
      dispatched: sequences.length,
      sequences: sequences.map((s: any) => ({
        id: s.id,
        name: s.name,
        previousStatus: s.status,
      })),
    };
  },
);
