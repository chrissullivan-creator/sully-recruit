import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

const BATCH_SIZE = 20;
const DELAY_MS = 500;

// Schedule in Trigger.dev Dashboard:
//   Task: linkedin-lookup
//   Cron: 0 2 * * * (daily at 2 AM UTC)
export const linkedinLookup = schedules.task({
  id: "linkedin-lookup",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");

    // Get candidates without linkedin_url who have a name
    const { data: candidates } = await supabase
      .from("candidates")
      .select("id, first_name, last_name, current_company, current_title, email")
      .is("linkedin_url", null)
      .not("first_name", "is", null)
      .not("last_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (!candidates?.length) {
      logger.info("No candidates need LinkedIn lookup");
      return { found: 0, notFound: 0, skipped: 0 };
    }

    logger.info(`Looking up LinkedIn for ${candidates.length} candidates`);

    let found = 0;
    let notFound = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const name = `${candidate.first_name} ${candidate.last_name}`.trim();
      if (!name || name.length < 3) {
        skipped++;
        continue;
      }

      try {
        // Build search keywords: name + company for better matching
        let keywords = name;
        if (candidate.current_company) {
          keywords += ` ${candidate.current_company}`;
        }

        const searchUrl = `${baseUrl}/users/search?keywords=${encodeURIComponent(keywords)}&limit=3`;
        const resp = await fetch(searchUrl, {
          headers: { "X-API-KEY": apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
          logger.warn("Search API error", { candidateId: candidate.id, status: resp.status });
          notFound++;
          await delay(DELAY_MS);
          continue;
        }

        const data = await resp.json();
        const results = data.items || data || [];

        // Find best match by comparing names
        const match = findBestMatch(results, candidate);

        if (match) {
          const linkedinUrl = match.linkedin_url || match.public_profile_url ||
            (match.provider_id ? `https://www.linkedin.com/in/${match.provider_id}` : null);

          const update: Record<string, any> = {};
          if (linkedinUrl) update.linkedin_url = linkedinUrl;
          if (match.provider_id) update.unipile_provider_id = match.provider_id;
          if (match.headline) update.linkedin_headline = match.headline;
          if (match.profile_picture_url || match.picture_url) {
            update.avatar_url = match.profile_picture_url || match.picture_url;
          }
          if (match.current_company && !candidate.current_company) {
            update.current_company = match.current_company;
          }
          if (match.current_title && !candidate.current_title) {
            update.current_title = match.current_title;
          }

          if (Object.keys(update).length > 0) {
            await supabase
              .from("candidates")
              .update(update as any)
              .eq("id", candidate.id);
            found++;
            logger.info("LinkedIn match found", { candidateId: candidate.id, name, linkedinUrl });
          }
        } else {
          notFound++;
        }

        await delay(DELAY_MS);
      } catch (err: any) {
        logger.warn("Lookup failed", { candidateId: candidate.id, error: err.message });
        notFound++;
      }
    }

    const summary = { found, notFound, skipped };
    logger.info("LinkedIn lookup complete", summary);
    return summary;
  },
});

function findBestMatch(
  results: any[],
  candidate: { first_name: string; last_name: string; current_company?: string; email?: string },
): any | null {
  if (!results?.length) return null;

  const firstName = (candidate.first_name || "").toLowerCase().trim();
  const lastName = (candidate.last_name || "").toLowerCase().trim();

  for (const result of results) {
    const rFirst = (result.first_name || result.given_name || "").toLowerCase().trim();
    const rLast = (result.last_name || result.family_name || "").toLowerCase().trim();
    const rFullName = (result.name || result.full_name || "").toLowerCase().trim();

    // Exact name match
    const nameMatch =
      (rFirst === firstName && rLast === lastName) ||
      rFullName === `${firstName} ${lastName}`;

    if (nameMatch) return result;

    // Fuzzy: first name starts with + last name matches
    if (rLast === lastName && rFirst.startsWith(firstName.slice(0, 3))) {
      return result;
    }
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
