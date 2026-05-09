import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import {
  advanceCurrentNode,
  checkSequenceComplete,
} from "../../../../src/trigger/lib/sequence-runner.js";

const PENDING_CONNECTION_TTL_DAYS = 21;

/**
 * Cancels any LinkedIn `pending_connection` step_log that has been
 * waiting longer than 21 days. Without this, an unaccepted invite
 * leaves the enrollment perpetually "incomplete" — checkSequenceComplete
 * counts pending_connection as not-done, so the enrollment row never
 * closes out and the UI shows it as still active.
 *
 * Daily at 02:00 UTC (off-hours so it doesn't compete with the 3-min
 * sweep). Ported from `src/trigger/sequence-scheduler.ts`'s
 * `pendingConnectionTimeout` task.
 */
export const pendingConnectionTimeout = inngest.createFunction(
  { id: "sequence-pending-connection-timeout", name: "Expire stale pending_connection step_logs (Inngest)" },
  { cron: "0 2 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(
      Date.now() - PENDING_CONNECTION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: stale, error } = await supabase
      .from("sequence_step_logs")
      .select("id, enrollment_id, sequence_enrollments!inner(id, candidate_id, contact_id, status)")
      .eq("status", "pending_connection")
      .lte("created_at", cutoff)
      .limit(200);

    if (error) {
      logger.error("Pending-connection sweep query failed", { error: error.message });
      return { action: "error" };
    }

    if (!stale || stale.length === 0) return { action: "idle" };

    logger.info(`Cancelling ${stale.length} pending_connection logs older than ${PENDING_CONNECTION_TTL_DAYS}d`);

    const ids = stale.map((s: any) => s.id);
    await supabase
      .from("sequence_step_logs")
      .update({ status: "cancelled", skip_reason: "connection_request_expired" } as any)
      .in("id", ids);

    // For each enrollment touched, advance the current_node_id pointer
    // and run checkSequenceComplete so we either move to the next step
    // or mark the enrollment completed.
    const seen = new Set<string>();
    for (const s of stale as any[]) {
      const enr = s.sequence_enrollments;
      if (!enr || seen.has(enr.id)) continue;
      seen.add(enr.id);
      await advanceCurrentNode(supabase, s.id);
      await checkSequenceComplete(supabase, enr, logger);
    }

    return { action: "expired", count: ids.length, enrollments: seen.size };
  },
);
