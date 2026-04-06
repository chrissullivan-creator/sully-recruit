import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl } from "./lib/supabase";

const BATCH_SIZE = 30;
const DELAY_MS = 400;

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
export const checkConnections = schedules.task({
  id: "check-connections",
  maxDuration: 180,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();

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

        // Get the API key for the account that sent the request
        const { data: account } = await supabase
          .from("integration_accounts")
          .select("access_token, unipile_account_id")
          .eq("id", channel.account_id)
          .single();

        if (!account?.access_token) {
          failed++;
          continue;
        }

        // Check the user's profile — if we can see their full profile,
        // the connection was likely accepted
        const resp = await fetch(
          `${baseUrl}/users/${encodeURIComponent(channel.provider_id)}?account_id=${account.unipile_account_id}`,
          {
            headers: { "X-API-KEY": account.access_token, Accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
          },
        );

        if (!resp.ok) {
          checked++;
          await delay(DELAY_MS);
          continue;
        }

        const profile = await resp.json();
        const isConnected =
          profile.is_connected === true ||
          profile.connection_status === "CONNECTED" ||
          profile.relationship === "CONNECTED" ||
          profile.distance === 1;

        if (isConnected) {
          // Connection accepted! Advance the enrollment
          const now = new Date();
          const nextStepAt = new Date(now.getTime() + 4 * 60 * 60 * 1000); // +4 hours

          await supabase
            .from("sequence_enrollments")
            .update({
              waiting_for_connection_acceptance: false,
              linkedin_connection_status: "accepted",
              linkedin_connection_accepted_at: now.toISOString(),
              next_step_at: nextStepAt.toISOString(),
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

          accepted++;
          logger.info("Connection accepted (caught by check)", {
            enrollmentId: enrollment.id,
            candidateId: enrollment.candidate_id,
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
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
