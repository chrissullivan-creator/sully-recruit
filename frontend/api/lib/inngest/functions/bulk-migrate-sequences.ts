import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client";

/**
 * Fan-out orchestrator. For every sequence still on `engine='trigger'` that has
 * at least one active enrollment, emit a `migrate-sequence-to-inngest.requested`
 * event. The migration of any one sequence is its own Inngest run so a partial
 * failure doesn't take the bulk down.
 *
 * Phase 1: this fan-out is wired but the per-sequence handler is a no-op (does
 * not flip `engine`). Phase 2 lights up the real cutover.
 */
export const bulkMigrateSequences = inngest.createFunction(
  { id: "bulk-migrate-sequences", name: "Bulk migrate sequences (Trigger.dev → Inngest)" },
  { event: "infra/bulk-migrate-sequences.requested" },
  async ({ event, step, logger }) => {
    const sequences = await step.run("list-trigger-sequences", async () => {
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );
      // engine is added by migration 20260509000000 — until generated types
      // catch up (regenerated weekly via .github/workflows/supabase-types.yml)
      // we cast through any so the query compiles.
      const { data, error } = await (supabase as any)
        .from("sequences")
        .select("id, name, sender_user_id, created_by, sequence_enrollments!inner(id)")
        .eq("engine", "trigger")
        .eq("status", "active")
        .eq("sequence_enrollments.status", "active");
      if (error) throw new Error(`list_sequences: ${error.message}`);
      // De-dup — the !inner join produces one row per enrollment.
      const seen = new Set<string>();
      return (data ?? []).filter((s: any) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    });

    logger.info("Found sequences to migrate", { count: sequences.length });

    if (sequences.length === 0) {
      return { dispatched: 0 };
    }

    await step.sendEvent(
      "fan-out-sequences",
      sequences.map((seq: any) => ({
        name: "infra/migrate-sequence-to-inngest.requested" as const,
        data: {
          sequenceId: seq.id,
          enrolledBy: event.data?.enrolledBy,
        },
      })),
    );

    return { dispatched: sequences.length, sequenceIds: sequences.map((s: any) => s.id) };
  },
);
