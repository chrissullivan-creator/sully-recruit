import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

/**
 * Scheduled task: clean up stale enrollments.
 *
 * Expires enrollments that have been waiting for LinkedIn connection
 * acceptance for 30+ days, and stops enrollments with no activity
 * for 60+ days.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: cleanup-stale-enrollments
 *   Cron: 0 5 * * * (daily at 5 AM UTC)
 */
export const cleanupStaleEnrollments = schedules.task({
  id: "cleanup-stale-enrollments",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const now = new Date();

    let connectionExpired = 0;
    let inactiveExpired = 0;

    // 1. Expire enrollments waiting for connection acceptance > 30 days
    const connectionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: staleConnections, error: connErr } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id")
      .eq("waiting_for_connection_acceptance", true)
      .eq("status", "active")
      .lt("updated_at", connectionCutoff);

    if (connErr) {
      logger.error("Failed to query stale connections", { error: connErr.message });
    } else if (staleConnections?.length) {
      const ids = staleConnections.map((e: any) => e.id);

      const { error: updateErr } = await supabase
        .from("sequence_enrollments")
        .update({
          status: "stopped",
          waiting_for_connection_acceptance: false,
          linkedin_connection_status: "expired",
          stopped_reason: "connection_request_expired_30d",
        } as any)
        .in("id", ids);

      if (updateErr) {
        logger.error("Failed to expire connections", { error: updateErr.message });
      } else {
        connectionExpired = ids.length;
        logger.info(`Expired ${ids.length} stale connection enrollments`);
      }
    }

    // 2. Stop enrollments with no activity for 60+ days
    const inactiveCutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const { data: inactive, error: inactiveErr } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq("status", "active")
      .lt("updated_at", inactiveCutoff)
      .is("next_step_at", null);

    if (inactiveErr) {
      logger.error("Failed to query inactive enrollments", { error: inactiveErr.message });
    } else if (inactive?.length) {
      const ids = inactive.map((e: any) => e.id);

      const { error: updateErr } = await supabase
        .from("sequence_enrollments")
        .update({
          status: "stopped",
          stopped_reason: "inactive_60d",
        } as any)
        .in("id", ids);

      if (updateErr) {
        logger.error("Failed to stop inactive enrollments", { error: updateErr.message });
      } else {
        inactiveExpired = ids.length;
        logger.info(`Stopped ${ids.length} inactive enrollments`);
      }
    }

    // 3. Cancel stale outbound LinkedIn connection requests (30+ days)
    // These clutter the LinkedIn account and waste connection slots
    const { data: staleInvites } = await supabase
      .from("sequence_step_executions")
      .select("id, external_message_id, enrollment_id")
      .eq("channel", "linkedin_connection")
      .eq("status", "sent")
      .lt("executed_at", connectionCutoff)
      .limit(50);

    let invitesWithdrawn = 0;
    if (staleInvites?.length) {
      for (const invite of staleInvites) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "expired" } as any)
          .eq("id", invite.id);
        invitesWithdrawn++;
      }
    }

    const summary = { connectionExpired, inactiveExpired, invitesWithdrawn };
    logger.info("Stale enrollment cleanup complete", summary);
    return summary;
  },
});
