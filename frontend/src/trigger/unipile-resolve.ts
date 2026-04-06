import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";
const BATCH_SIZE = 25;
const DELAY_MS = 350;
const FETCH_TIMEOUT_MS = 5_000; // 5s timeout per API call
const MAX_ELAPSED_MS = 240_000; // 4 min safety margin

/**
 * Scheduled task: resolve Unipile IDs for candidates with LinkedIn URLs.
 *
 * Finds candidates that have a linkedin_url but no resolved Unipile ID
 * in candidate_channels, then resolves them via Unipile's user lookup API.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: resolve-unipile-ids
 *   Cron: every 2 hours (0 at minute 0)
 */
export const resolveUnipileIds = schedules.task({
  id: "resolve-unipile-ids",
  maxDuration: 180, // 3 min hard cap for this task
  run: async () => {
    const supabase = getSupabaseAdmin();

    // 1. Get Unipile API key from app_settings and account ID from integration_accounts
    const apiKey = await getAppSetting("UNIPILE_API_KEY");
    const UNIPILE_BASE_URL = await getUnipileBaseUrl();

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id")
      .or(
        "account_type.eq.linkedin,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator,account_type.eq.linkedin_classic"
      )
      .eq("is_active", true)
      .not("unipile_account_id", "is", null)
      .limit(1);

    const unipileAccountId = accounts?.[0]?.unipile_account_id as string | null;

    // 2. Find candidates with linkedin_url but no resolved candidate_channels entry
    //    Order by created_at DESC (newest first) as user requested
    const { data: candidates, error: queryErr } = await supabase
      .from("candidates")
      .select(
        "id, linkedin_url, unipile_resolve_status"
      )
      .not("linkedin_url", "is", null)
      .neq("linkedin_url", "")
      .or("unipile_resolve_status.is.null,unipile_resolve_status.eq.pending")
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (queryErr) {
      logger.error("Failed to query candidates", { error: queryErr.message });
      throw new Error(`Query failed: ${queryErr.message}`);
    }

    if (!candidates || candidates.length === 0) {
      logger.info("No candidates need Unipile resolution");
      return { resolved: 0, failed: 0, skipped: 0 };
    }

    logger.info(`Processing ${candidates.length} candidates for Unipile resolution`);

    let resolved = 0;
    let failed = 0;
    let skipped = 0;
    const startTime = Date.now();

    for (const candidate of candidates) {
      // Break early if approaching max duration
      if (Date.now() - startTime > MAX_ELAPSED_MS) {
        logger.warn("Approaching max duration — stopping batch early", { resolved, failed, skipped });
        break;
      }

      try {
        // Extract LinkedIn slug from URL
        const slug = extractLinkedInSlug(candidate.linkedin_url);
        if (!slug) {
          logger.warn("Could not extract LinkedIn slug", {
            candidateId: candidate.id,
            url: candidate.linkedin_url,
          });
          await supabase
            .from("candidates")
            .update({ unipile_resolve_status: "invalid_url" } as any)
            .eq("id", candidate.id);
          skipped++;
          continue;
        }

        // Call Unipile user lookup API directly
        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "X-UNIPILE-CLIENT": "sully-recruit",
        };

        const resp = await fetchWithTimeout(
          `${UNIPILE_BASE_URL}/users/${encodeURIComponent(slug)}`,
          { headers },
          FETCH_TIMEOUT_MS
        );

        if (!resp.ok) {
          const status = resp.status;
          if (status === 404) {
            // Profile not found on Unipile
            await supabase
              .from("candidates")
              .update({ unipile_resolve_status: "not_found" } as any)
              .eq("id", candidate.id);
            skipped++;
          } else if (status === 429) {
            // Rate limited — stop processing this batch
            logger.warn("Rate limited by Unipile — stopping batch", { resolved, failed, skipped });
            break;
          } else {
            logger.warn("Unipile API error", { candidateId: candidate.id, status });
            failed++;
          }
          await delay(DELAY_MS);
          continue;
        }

        const profile = await resp.json();
        const unipileId = profile.id ?? null;
        const providerId =
          profile.provider_id ?? profile.public_identifier ?? null;

        // Upsert into candidate_channels
        if (unipileId || providerId) {
          await supabase.from("candidate_channels").upsert(
            {
              candidate_id: candidate.id,
              channel: "linkedin",
              unipile_id: unipileId,
              provider_id: providerId,
              is_connected: true,
              account_id: account.id,
            } as any,
            { onConflict: "candidate_id,channel" }
          );

          // Update candidate resolve status + store IDs + full profile data
          const enrichment: Record<string, any> = {
            unipile_id: unipileId,
            unipile_provider_id: providerId,
            unipile_resolve_status: "resolved",
            linkedin_profile_data: JSON.stringify(profile),
          };

          // Extract headline, company, title, avatar from profile if not already set
          const headline = profile.headline ?? null;
          if (headline) enrichment.linkedin_headline = headline;

          const avatarUrl = profile.profile_picture_url ?? profile.picture_url ?? profile.image_url ?? null;
          if (avatarUrl) enrichment.avatar_url = avatarUrl;

          const positions = profile.positions ?? profile.experience ?? [];
          if (positions.length > 0) {
            const current = positions.find((p: any) => p.is_current || !p.end_date) ?? positions[0];
            if (current?.company?.name || current?.company_name) {
              enrichment.current_company = current.company?.name ?? current.company_name;
            }
            if (current?.title || current?.role) {
              enrichment.current_title = current.title ?? current.role;
            }
          }

          await supabase
            .from("candidates")
            .update(enrichment as any)
            .eq("id", candidate.id);

          resolved++;
          logger.info("Resolved", {
            candidateId: candidate.id,
            slug,
            unipileId,
            providerId,
          });
        } else {
          await supabase
            .from("candidates")
            .update({ unipile_resolve_status: "no_ids" } as any)
            .eq("id", candidate.id);
          skipped++;
        }
      } catch (err: any) {
        logger.error("Error resolving candidate", {
          candidateId: candidate.id,
          error: err.message,
        });
        failed++;
      }

      // Rate limit delay between requests
      await delay(DELAY_MS);
    }

    logger.info("Unipile resolution batch complete", {
      resolved,
      failed,
      skipped,
    });
    return { resolved, failed, skipped };
  },
});

function extractLinkedInSlug(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();

  // Full URL: https://linkedin.com/in/john-doe-123abc
  const match = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (match) return match[1];

  // Bare slug: john-doe-123abc
  if (/^[\w-]+$/.test(trimmed)) return trimmed;

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
