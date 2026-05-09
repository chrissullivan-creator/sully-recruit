import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch } from "./lib/unipile-v2";
import { calculatePostConnectionSendTime } from "./lib/send-time-calculator";

const BATCH_SIZE = 30;
const DELAY_MS = 400;

/**
 * When a connection is detected as accepted (either via webhook or this
 * scheduled fallback), we need to do TWO things to advance the
 * enrollment:
 *   1. Flip the gate flag on sequence_enrollments
 *   2. Promote any pending_connection step_logs to scheduled
 *
 * The Unipile webhook handler (advanceOnConnectionAccepted in
 * webhook-unipile.ts) already handles both. This helper is the
 * mirror image for the polling fallback — without it, missed webhooks
 * leave step_logs parked at pending_connection forever and the
 * follow-up message never fires.
 */
async function schedulePendingConnectionLogs(
  supabase: any,
  enrollmentId: string,
  acceptedAt: Date,
): Promise<number> {
  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (!enrollment) return 0;

  const sequence = enrollment.sequences;
  const senderUserId = sequence.sender_user_id || sequence.created_by;

  const { data: pendingLogs } = await supabase
    .from("sequence_step_logs")
    .select("id, sequence_actions!inner(base_delay_hours, delay_interval_minutes, jiggle_minutes)")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "pending_connection");
  if (!pendingLogs?.length) return 0;

  for (const log of pendingLogs as any[]) {
    const action = log.sequence_actions;
    const scheduledAt = await calculatePostConnectionSendTime(
      supabase,
      acceptedAt,
      Number(action.base_delay_hours) || 0,
      action.delay_interval_minutes || 0,
      action.jiggle_minutes || 0,
      sequence.send_window_start || "09:00",
      sequence.send_window_end || "18:00",
      senderUserId,
    );
    await supabase
      .from("sequence_step_logs")
      .update({ scheduled_at: scheduledAt.toISOString(), status: "scheduled" } as any)
      .eq("id", log.id);
  }
  return pendingLogs.length;
}

/**
 * Scheduled task: check pending LinkedIn connection requests.
 *
 * Finds enrollments waiting for connection acceptance and verifies
 * their status via Unipile — catches acceptances that webhooks may
 * have missed and advances the enrollment.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: check-connections
 *   Cron: 0 0/4 * * * (every 4 hours)
 */
/**
 * Pure run body — extracted so the Inngest port and the Trigger.dev
 * scheduled task share one source of truth. Phase 5b deletes the
 * Trigger.dev wrapper.
 */
export async function runCheckConnections() {
  const supabase = getSupabaseAdmin();

    // Find enrollments stuck waiting for connection acceptance
    const { data: enrollments, error } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id, enrolled_by")
      .eq("waiting_for_connection_acceptance", true)
      .eq("status", "active")
      .limit(BATCH_SIZE);

    if (error) {
      logger.error("Failed to query enrollments", { error: error.message });
      throw new Error(`Query failed: ${error.message}`);
    }

    if (!enrollments?.length) {
      logger.info("No pending connection enrollments");
      return { checked: 0, accepted: 0, failed: 0 };
    }

    logger.info(`Checking ${enrollments.length} pending connections`);

    let checked = 0;
    let accepted = 0;
    let failed = 0;

    for (const enrollment of enrollments) {
      try {
        // Get candidate's LinkedIn info
        const { data: channel } = await supabase
          .from("candidate_channels")
          .select("provider_id, unipile_id, account_id")
          .eq("candidate_id", enrollment.candidate_id)
          .eq("channel", "linkedin")
          .maybeSingle();

        if (!channel?.provider_id) {
          checked++;
          continue;
        }

        // Get the unipile_account_id for the account that sent the request
        const { data: account } = await supabase
          .from("integration_accounts")
          .select("unipile_account_id")
          .eq("id", channel.account_id)
          .not("unipile_account_id", "is", null)
          .single();

        if (!account?.unipile_account_id) {
          failed++;
          continue;
        }

        // Check the user's profile — if we can see their full profile,
        // the connection was likely accepted.
        // v2 path: GET /api/v2/{account_id}/linkedin/users/{provider_id}
        let profile: any;
        try {
          profile = await unipileFetch(
            supabase,
            account.unipile_account_id,
            `linkedin/users/${encodeURIComponent(channel.provider_id)}`,
            { method: "GET" },
          );
        } catch {
          checked++;
          await delay(DELAY_MS);
          continue;
        }

        const isConnected =
          profile.is_connected === true ||
          profile.connection_status === "CONNECTED" ||
          profile.relationship === "CONNECTED" ||
          profile.distance === 1;

        if (isConnected) {
          // Connection accepted — flip the gate so the sequence
          // scheduler picks the enrollment up on its next pass. The
          // scheduler reads sequence_step_logs to compute the next
          // send time; no need to stamp next_step_at here.
          const now = new Date();

          await supabase
            .from("sequence_enrollments")
            .update({
              waiting_for_connection_acceptance: false,
              linkedin_connection_status: "accepted",
              linkedin_connection_accepted_at: now.toISOString(),
            } as any)
            .eq("id", enrollment.id);

          // Update candidate channel
          await supabase
            .from("candidate_channels")
            .update({
              is_connected: true,
              connected_at: now.toISOString(),
            } as any)
            .eq("candidate_id", enrollment.candidate_id)
            .eq("channel", "linkedin");

          // Promote any pending_connection step_logs to scheduled.
          // Without this, missed webhooks leave the follow-up step
          // parked forever — the webhook handler does this, but if it
          // never fired we'd never reach it.
          const promoted = await schedulePendingConnectionLogs(supabase, enrollment.id, now);

          accepted++;
          logger.info("Connection accepted (caught by check)", {
            enrollmentId: enrollment.id,
            candidateId: enrollment.candidate_id,
            promotedLogs: promoted,
          });
        }

        checked++;
        await delay(DELAY_MS);
      } catch (err: any) {
        logger.warn("Error checking connection", {
          enrollmentId: enrollment.id,
          error: err.message,
        });
        failed++;
      }
    }

    logger.info("Connection check complete", { checked, accepted, failed });
    return { checked, accepted, failed };
}

// MIGRATED to Inngest — see frontend/src/inngest/functions/check-connections.ts.
// The cron schedule (every 4h) is owned by the Inngest function now.
// Running both simultaneously would double the Unipile API calls
// against the same accounts; gutting this wrapper to a no-op stops the
// Trigger.dev scheduler from firing.
//
// Other Trigger.dev tasks calling `checkConnections.trigger(...)`
// directly (none currently) would silently no-op, which is fine
// — they should send `linkedin/check-connections.requested` instead.
export const checkConnections = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
