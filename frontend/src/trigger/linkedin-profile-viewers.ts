import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

/**
 * Scheduled task: track LinkedIn profile viewers.
 *
 * Fetches people who recently viewed your LinkedIn profile and
 * matches them against candidates/contacts in the database.
 * Creates notifications for matched viewers and optionally adds
 * new viewers as candidate leads.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: track-profile-viewers
 *   Cron: 0 0/6 * * * (every 6 hours)
 */
export const trackProfileViewers = schedules.task({
  id: "track-profile-viewers",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");

    // Get all active LinkedIn accounts
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, owner_user_id")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      logger.info("No active LinkedIn accounts");
      return { matched: 0, new_leads: 0 };
    }

    let matched = 0;
    let newLeads = 0;

    for (const account of accounts) {

      try {
        // Use Unipile search with "viewed_your_profile_recently" filter
        const resp = await fetch(
          `${baseUrl}/users/search?viewed_your_profile_recently=true&account_id=${account.unipile_account_id}&limit=50`,
          {
            headers: { "X-API-KEY": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!resp.ok) {
          logger.warn("Profile viewers fetch failed", { status: resp.status, accountId: account.id });
          continue;
        }

        const data = await resp.json();
        const viewers = data.items || data || [];

        for (const viewer of viewers) {
          const providerId = viewer.provider_id || viewer.public_identifier;
          const linkedinUrl = viewer.linkedin_url || (providerId ? `https://linkedin.com/in/${providerId}` : null);
          if (!providerId) continue;

          // Check if this viewer is an existing candidate
          const { data: candidateMatch } = await supabase
            .from("candidate_channels")
            .select("candidate_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          // Check if this viewer is an existing contact
          const { data: contactMatch } = await supabase
            .from("contact_channels")
            .select("contact_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          if (candidateMatch || contactMatch) {
            // Known person viewed profile — create a task/notification
            const entityType = candidateMatch ? "candidate" : "contact";
            const entityId = candidateMatch?.candidate_id || contactMatch?.contact_id;

            await supabase.from("tasks").insert({
              title: `${viewer.first_name || ""} ${viewer.last_name || ""} viewed your LinkedIn profile`.trim(),
              description: `${viewer.headline || ""}\n${viewer.company || ""}`.trim() || null,
              task_type: "follow_up",
              priority: "medium",
              status: "pending",
              candidate_id: candidateMatch?.candidate_id || null,
              contact_id: contactMatch?.contact_id || null,
              assigned_to: account.owner_user_id,
              due_date: new Date().toISOString(),
            } as any);

            matched++;
            logger.info("Profile viewer matched", { entityType, entityId, viewer: providerId });
          } else if (linkedinUrl) {
            // Unknown viewer — add as a candidate lead
            const fullName = [viewer.first_name, viewer.last_name].filter(Boolean).join(" ");
            if (!fullName) continue;

            // Check if candidate already exists by LinkedIn URL
            const { data: existingCandidate } = await supabase
              .from("candidates")
              .select("id")
              .eq("linkedin_url", linkedinUrl)
              .maybeSingle();

            if (!existingCandidate) {
              await supabase.from("candidates").insert({
                full_name: fullName,
                linkedin_url: linkedinUrl,
                title: viewer.headline || viewer.title || null,
                company: viewer.company || null,
                source: "linkedin_profile_viewer",
                unipile_provider_id: providerId,
                unipile_resolve_status: "resolved",
              } as any);

              newLeads++;
              logger.info("New lead from profile viewer", { name: fullName, providerId });
            }
          }
        }
      } catch (err: any) {
        logger.error("Profile viewer tracking error", { accountId: account.id, error: err.message });
      }
    }

    logger.info("Profile viewer tracking complete", { matched, new_leads: newLeads });
    return { matched, new_leads: newLeads };
  },
});
