import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";
import { unipileFetch } from "../../../../src/trigger/lib/unipile-v2.js";
import { calculatePostConnectionSendTime } from "../../../../src/trigger/lib/send-time-calculator.js";

const BATCH_SIZE = 30;
const DELAY_MS = 400;

/**
 * Polling fallback for the Unipile connection-accepted webhook. Without
 * this, missed webhooks leave LinkedIn-connection step_logs parked at
 * `pending_connection` forever and the follow-up message never fires.
 *
 * Mirrors what `advanceOnConnectionAccepted` does in
 * `src/trigger/webhook-unipile.ts`:
 *   1. Flip `waiting_for_connection_acceptance=false` on the enrollment
 *   2. Promote any `pending_connection` step_logs to `scheduled` with a
 *      window-aware send time anchored on the acceptance timestamp
 *
 * Ported from `src/trigger/check-connections.ts`. Inngest is the only
 * scheduler now — Trigger.dev's copy is removed so they don't both
 * thrash Unipile.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const checkConnections = inngest.createFunction(
  { id: "check-connections", name: "Check pending LinkedIn connections (Inngest)" },
  { cron: "0 0/4 * * *" },
  async ({ logger }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

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

        // v2: GET /api/v2/{account_id}/linkedin/users/{provider_id}
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
          const now = new Date();

          await supabase
            .from("sequence_enrollments")
            .update({
              waiting_for_connection_acceptance: false,
              linkedin_connection_status: "accepted",
              linkedin_connection_accepted_at: now.toISOString(),
            } as any)
            .eq("id", enrollment.id);

          await supabase
            .from("candidate_channels")
            .update({
              is_connected: true,
              connected_at: now.toISOString(),
            } as any)
            .eq("candidate_id", enrollment.candidate_id)
            .eq("channel", "linkedin");

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
  },
);
