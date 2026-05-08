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
          stop_trigger: "connection_expired",
          stop_reason: "connection_request_expired_30d",
          stopped_reason: "connection_request_expired_30d",
          stopped_at: new Date().toISOString(),
        } as any)
        .in("id", ids);

      // Also cancel any pending v2 step logs for these enrollments
      await supabase
        .from("sequence_step_logs")
        .update({ status: "cancelled" } as any)
        .in("enrollment_id", ids)
        .in("status", ["scheduled", "pending_connection"]);

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
          stop_trigger: "inactive_expired",
          stop_reason: "inactive_60d",
          stopped_reason: "inactive_60d",
          stopped_at: new Date().toISOString(),
        } as any)
        .in("id", ids);

      // Also cancel any pending v2 step logs for these enrollments
      await supabase
        .from("sequence_step_logs")
        .update({ status: "cancelled" } as any)
        .in("enrollment_id", ids)
        .in("status", ["scheduled", "pending_connection"]);

      if (updateErr) {
        logger.error("Failed to stop inactive enrollments", { error: updateErr.message });
      } else {
        inactiveExpired = ids.length;
        logger.info(`Stopped ${ids.length} inactive enrollments`);
      }
    }

    // 3. Cancel stale outbound LinkedIn connection requests (30+ days)
    // These clutter the LinkedIn account and waste connection slots.
    // sequence_step_executions was the v1 table — dropped in the v2
    // schema migration; only sequence_step_logs is live now.
    const { data: staleInvitesV2 } = await supabase
      .from("sequence_step_logs")
      .select("id")
      .eq("channel", "linkedin_connection")
      .eq("status", "sent")
      .lt("sent_at", connectionCutoff)
      .limit(50);

    let invitesWithdrawn = 0;
    for (const invite of staleInvitesV2 || []) {
      await supabase
        .from("sequence_step_logs")
        .update({ status: "expired" } as any)
        .eq("id", invite.id);
      invitesWithdrawn++;
    }

    const summary = { connectionExpired, inactiveExpired, invitesWithdrawn };
    logger.info("Stale enrollment cleanup complete", summary);
    return summary;
  },
});
