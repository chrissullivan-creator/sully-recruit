import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";

/**
 * Daily cleanup pass over `sequence_enrollments`:
 *   - Expire enrollments waiting for LinkedIn connection acceptance for
 *     30+ days (UI shows them as "active" forever otherwise).
 *   - Stop enrollments with no activity in 60 days.
 *   - Mark sent linkedin_connection step_logs older than 30d as expired
 *     so the LinkedIn account's outbound-invite slot frees up.
 *
 * Ported from `src/trigger/cleanup-stale-enrollments.ts`. Inngest is
 * the only scheduler now.
 */
export const cleanupStaleEnrollments = inngest.createFunction(
  { id: "cleanup-stale-enrollments", name: "Cleanup stale sequence enrollments (Inngest)" },
  { cron: "0 5 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const now = new Date();

    let connectionExpired = 0;
    let inactiveExpired = 0;

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
          stopped_at: new Date().toISOString(),
        } as any)
        .in("id", ids);

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

    const inactiveCutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const { data: inactive, error: inactiveErr } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq("status", "active")
      .lt("updated_at", inactiveCutoff);

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
          stopped_at: new Date().toISOString(),
        } as any)
        .in("id", ids);

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

    // Cancel stale outbound LinkedIn connection requests (30+ days). They
    // clutter the LinkedIn account and waste connection slots.
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
);
