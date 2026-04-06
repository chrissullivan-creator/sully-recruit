import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

const DELAY_MS = 500;

/**
 * Scheduled task: auto-accept inbound LinkedIn connection requests
 * from known candidates and contacts.
 *
 * Only accepts requests from people already in the database — unknown
 * senders are left for manual review.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: auto-accept-connections
 *   Cron: 0 0/3 * * * (every 3 hours)
 */
export const autoAcceptConnections = schedules.task({
  id: "auto-accept-connections",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, owner_user_id")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      return { accepted: 0, skipped: 0 };
    }

    let totalAccepted = 0;
    let totalSkipped = 0;

    for (const account of accounts) {

      try {
        // Fetch pending inbound connection requests
        const resp = await fetch(
          `${baseUrl}/invitations/received?account_id=${account.unipile_account_id}&limit=50`,
          {
            headers: { "X-API-KEY": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!resp.ok) {
          logger.warn("Failed to fetch invitations", { status: resp.status });
          continue;
        }

        const data = await resp.json();
        const invitations = data.items || data || [];

        for (const invite of invitations) {
          const senderId = invite.sender?.provider_id || invite.provider_id;
          const inviteId = invite.id;
          if (!senderId || !inviteId) continue;

          // Check if sender is a known candidate
          const { data: candidateMatch } = await supabase
            .from("candidate_channels")
            .select("candidate_id")
            .eq("provider_id", senderId)
            .eq("channel", "linkedin")
            .maybeSingle();

          // Check if sender is a known contact
          const { data: contactMatch } = await supabase
            .from("contact_channels")
            .select("contact_id")
            .eq("provider_id", senderId)
            .eq("channel", "linkedin")
            .maybeSingle();

          // Also check by LinkedIn URL pattern
          let candidateByUrl = null;
          if (!candidateMatch && !contactMatch) {
            const slug = senderId;
            const { data: byUrl } = await supabase
              .from("candidates")
              .select("id")
              .ilike("linkedin_url", `%${slug}%`)
              .maybeSingle();
            candidateByUrl = byUrl;
          }

          if (candidateMatch || contactMatch || candidateByUrl) {
            // Accept the connection
            const acceptResp = await fetch(
              `${baseUrl}/invitations/${encodeURIComponent(inviteId)}/accept`,
              {
                method: "POST",
                headers: { "X-API-KEY": apiKey },
                signal: AbortSignal.timeout(5_000),
              },
            );

            if (acceptResp.ok) {
              totalAccepted++;

              // Update connection status in channel records
              const entityId = candidateMatch?.candidate_id || candidateByUrl?.id;
              if (entityId) {
                await supabase
                  .from("candidate_channels")
                  .upsert({
                    candidate_id: entityId,
                    channel: "linkedin",
                    provider_id: senderId,
                    is_connected: true,
                    connected_at: new Date().toISOString(),
                    account_id: account.id,
                  } as any, { onConflict: "candidate_id,channel" });

                // If there's an enrollment waiting for this connection, advance it
                const { data: enrollment } = await supabase
                  .from("sequence_enrollments")
                  .select("id")
                  .eq("candidate_id", entityId)
                  .eq("waiting_for_connection_acceptance", true)
                  .eq("status", "active")
                  .maybeSingle();

                if (enrollment) {
                  const nextStepAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
                  await supabase
                    .from("sequence_enrollments")
                    .update({
                      waiting_for_connection_acceptance: false,
                      linkedin_connection_status: "accepted",
                      linkedin_connection_accepted_at: new Date().toISOString(),
                      next_step_at: nextStepAt,
                    } as any)
                    .eq("id", enrollment.id);
                }
              }

              if (contactMatch) {
                await supabase
                  .from("contact_channels")
                  .update({
                    is_connected: true,
                    connected_at: new Date().toISOString(),
                  } as any)
                  .eq("contact_id", contactMatch.contact_id)
                  .eq("channel", "linkedin");
              }

              const senderName = [invite.sender?.first_name, invite.sender?.last_name].filter(Boolean).join(" ");
              logger.info("Auto-accepted connection", { senderId, senderName, inviteId });
            }

            await delay(DELAY_MS);
          } else {
            totalSkipped++;
          }
        }
      } catch (err: any) {
        logger.error("Auto-accept error", { accountId: account.id, error: err.message });
      }
    }

    logger.info("Auto-accept connections complete", { accepted: totalAccepted, skipped: totalSkipped });
    return { accepted: totalAccepted, skipped: totalSkipped };
  },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
