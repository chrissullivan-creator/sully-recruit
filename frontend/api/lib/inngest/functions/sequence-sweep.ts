import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";

/**
 * Inngest mirror of the Trigger.dev `sequenceSweep` task. Runs every 3
 * minutes, picks up step_logs whose `scheduled_at <= now` for sequences on
 * `engine='inngest'`, atomically claims them ('scheduled' → 'in_flight'),
 * and fans out a `sequence/action.execute.requested` event per claim.
 *
 * The engine='inngest' filter is the only divergence from the Trigger.dev
 * sweep — without it the two sweeps would race for the same row and a
 * single physical send could fire twice.
 *
 * Stuck-in-flight recovery (>10 min) runs on every tick and is engine-
 * agnostic: a row claimed by Trigger.dev that never completed (process
 * crash, network kill) gets reset to 'scheduled' and the next sweep —
 * whichever engine the sequence is on now — picks it up cleanly.
 */
export const sequenceSweep = inngest.createFunction(
  { id: "sequence-sweep", name: "Sweep due sequence step_logs (engine=inngest)" },
  { cron: "*/3 * * * *" },
  async ({ step, logger }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // Recover any in_flight rows older than 10 minutes — handles crashes
    // mid-execute on either engine.
    await step.run("recover-stuck-in-flight", async () => {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { error } = await (supabase as any)
        .from("sequence_step_logs")
        .update({ status: "scheduled" })
        .eq("status", "in_flight")
        .lt("updated_at", tenMinAgo);
      // Don't swallow: a failed recovery silently leaves rows stuck in_flight
      // forever, blocking re-scheduling. Log so the next tick (and ops) can see it.
      if (error) logger.warn("recover-stuck-in-flight failed; will retry next tick", { error: error.message });
    });

    const dueLogs: any[] = await step.run("find-due", async () => {
      const now = new Date().toISOString();
      const { data, error } = await (supabase as any)
        .from("sequence_step_logs")
        .select(`
          id, enrollment_id, action_id, node_id, channel,
          sequence_enrollments!inner(
            id, sequence_id, candidate_id, contact_id, status,
            sequences!inner(id, status, engine, created_by, sender_user_id)
          )
        `)
        .eq("status", "scheduled")
        .lte("scheduled_at", now)
        .eq("sequence_enrollments.status", "active")
        .eq("sequence_enrollments.sequences.status", "active")
        .eq("sequence_enrollments.sequences.engine", "inngest")
        .limit(100);
      if (error) throw new Error(`sweep_query: ${error.message}`);
      return data ?? [];
    });

    if (dueLogs.length === 0) {
      return { action: "idle", due: 0 };
    }

    logger.info(`Sweep found ${dueLogs.length} due actions`);

    // Atomically claim each row before dispatching. The UPDATE only matches
    // rows still in 'scheduled', so overlapping sweeps can't double-claim.
    const claimedIds = await step.run("claim", async () => {
      const ids: string[] = [];
      for (const log of dueLogs) {
        const { data, error } = await (supabase as any)
          .from("sequence_step_logs")
          .update({ status: "in_flight" })
          .eq("id", log.id)
          .eq("status", "scheduled")
          .select("id")
          .maybeSingle();
        if (error) {
          logger.warn("Claim failed (skipping row)", { id: log.id, error: error.message });
          continue;
        }
        if (data?.id) ids.push(data.id);
      }
      return ids;
    });

    if (claimedIds.length === 0) {
      return { action: "claimed_none", found: dueLogs.length };
    }

    const claimedById = new Map(dueLogs.map((l) => [l.id, l]));
    const events = claimedIds.map((id) => {
      const log = claimedById.get(id)!;
      const enrollment = log.sequence_enrollments;
      const sequence = enrollment?.sequences;
      return {
        name: "sequence/action.execute.requested" as const,
        data: {
          stepLogId: log.id,
          enrollmentId: enrollment.id,
          actionId: log.action_id,
          nodeId: log.node_id,
          sequenceId: enrollment.sequence_id,
          candidateId: enrollment.candidate_id || undefined,
          contactId: enrollment.contact_id || undefined,
          enrolledBy: sequence?.sender_user_id || sequence?.created_by,
        },
      };
    });

    await step.sendEvent("dispatch-actions", events);

    return { action: "dispatched", count: claimedIds.length, found: dueLogs.length };
  },
);
