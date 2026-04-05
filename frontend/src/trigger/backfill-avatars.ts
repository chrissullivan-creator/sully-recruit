import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl } from "./lib/supabase";

const BATCH_SIZE = 50;
const DELAY_MS = 400;

/**
 * Scheduled task: backfill profile pictures and company logos.
 *
 * 1. Extracts avatar_url from stored linkedin_profile_data (no API calls needed)
 * 2. For candidates without stored profile data, fetches from Unipile API
 * 3. Fetches company logos from Unipile company profiles
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: backfill-avatars
 *   Cron: 0 3 * * * (daily at 3 AM UTC)
 */
export const backfillAvatars = schedules.task({
  id: "backfill-avatars",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();
    let localUpdated = 0;
    let apiUpdated = 0;
    let companiesUpdated = 0;

    // ── 1. Extract from existing linkedin_profile_data (free, no API) ──
    const { data: withProfileData } = await supabase
      .from("candidates")
      .select("id, linkedin_profile_data")
      .is("avatar_url", null)
      .not("linkedin_profile_data", "is", null)
      .limit(BATCH_SIZE);

    for (const candidate of withProfileData || []) {
      try {
        const profile =
          typeof candidate.linkedin_profile_data === "string"
            ? JSON.parse(candidate.linkedin_profile_data)
            : candidate.linkedin_profile_data;

        const avatarUrl =
          profile?.profile_picture_url ??
          profile?.picture_url ??
          profile?.image_url ??
          null;

        if (avatarUrl) {
          await supabase
            .from("candidates")
            .update({ avatar_url: avatarUrl } as any)
            .eq("id", candidate.id);
          localUpdated++;
        }
      } catch {
        // Skip parse errors
      }
    }

    // ── 2. Fetch from Unipile API for candidates without profile data ──
    const baseUrl = await getUnipileBaseUrl();
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, access_token, unipile_account_id")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .limit(1);

    const account = accounts?.[0];
    if (account?.access_token) {
      const { data: needsAvatar } = await supabase
        .from("candidates")
        .select("id, linkedin_url, unipile_provider_id")
        .is("avatar_url", null)
        .is("linkedin_profile_data", null)
        .not("linkedin_url", "is", null)
        .limit(20); // Smaller batch for API calls

      for (const candidate of needsAvatar || []) {
        const slug =
          candidate.unipile_provider_id ||
          candidate.linkedin_url?.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
        if (!slug) continue;

        try {
          const resp = await fetch(
            `${baseUrl}/users/${encodeURIComponent(slug)}`,
            {
              headers: { "X-API-KEY": account.access_token, Accept: "application/json" },
              signal: AbortSignal.timeout(5_000),
            },
          );

          if (resp.ok) {
            const profile = await resp.json();
            const avatarUrl =
              profile.profile_picture_url ?? profile.picture_url ?? profile.image_url ?? null;

            const update: Record<string, any> = {
              linkedin_profile_data: JSON.stringify(profile),
            };
            if (avatarUrl) update.avatar_url = avatarUrl;

            await supabase
              .from("candidates")
              .update(update as any)
              .eq("id", candidate.id);

            if (avatarUrl) apiUpdated++;
          }

          await delay(DELAY_MS);
        } catch {
          // Skip failures
        }
      }

      // ── 3. Backfill contact avatars ──
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, linkedin_url")
        .is("avatar_url", null)
        .not("linkedin_url", "is", null)
        .limit(20);

      for (const contact of contacts || []) {
        const slug = contact.linkedin_url?.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
        if (!slug) continue;

        try {
          const resp = await fetch(
            `${baseUrl}/users/${encodeURIComponent(slug)}`,
            {
              headers: { "X-API-KEY": account.access_token, Accept: "application/json" },
              signal: AbortSignal.timeout(5_000),
            },
          );

          if (resp.ok) {
            const profile = await resp.json();
            const avatarUrl =
              profile.profile_picture_url ?? profile.picture_url ?? profile.image_url ?? null;

            if (avatarUrl) {
              await supabase
                .from("contacts")
                .update({ avatar_url: avatarUrl } as any)
                .eq("id", contact.id);
              apiUpdated++;
            }
          }

          await delay(DELAY_MS);
        } catch {
          // Skip failures
        }
      }

      // ── 4. Backfill company logos ──
      const { data: companies } = await supabase
        .from("companies")
        .select("id, name, linkedin_url")
        .is("logo_url", null)
        .not("linkedin_url", "is", null)
        .limit(20);

      for (const company of companies || []) {
        const slug = company.linkedin_url?.match(/linkedin\.com\/company\/([^/?#]+)/)?.[1];
        if (!slug) continue;

        try {
          const resp = await fetch(
            `${baseUrl}/companies/${encodeURIComponent(slug)}`,
            {
              headers: { "X-API-KEY": account.access_token, Accept: "application/json" },
              signal: AbortSignal.timeout(5_000),
            },
          );

          if (resp.ok) {
            const profile = await resp.json();
            const logoUrl =
              profile.logo_url ?? profile.profile_picture_url ?? profile.picture_url ?? null;

            if (logoUrl) {
              await supabase
                .from("companies")
                .update({ logo_url: logoUrl } as any)
                .eq("id", company.id);
              companiesUpdated++;
            }
          }

          await delay(DELAY_MS);
        } catch {
          // Skip failures
        }
      }
    }

    const summary = { localUpdated, apiUpdated, companiesUpdated };
    logger.info("Avatar backfill complete", summary);
    return summary;
  },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
