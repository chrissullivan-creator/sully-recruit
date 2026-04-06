import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

const BATCH_SIZE = 20;
const DELAY_MS = 500;

// Schedule in Trigger.dev Dashboard:
//   Task: linkedin-lookup
//   Cron: 0 0/2 * * * (every 2 hours)
export const linkedinLookup = schedules.task({
  id: "linkedin-lookup",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");

    let found = 0;
    let notFound = 0;
    let skipped = 0;

    // ── 1. Candidates without linkedin_url ──
    const { data: candidates } = await supabase
      .from("candidates")
      .select("id, first_name, last_name, current_company, current_title, email")
      .is("linkedin_url", null)
      .not("first_name", "is", null)
      .not("last_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (candidates?.length) {
      logger.info(`Looking up LinkedIn for ${candidates.length} candidates`);
      const result = await lookupBatch(supabase, baseUrl, apiKey, candidates, "candidates");
      found += result.found;
      notFound += result.notFound;
      skipped += result.skipped;
    }

    // ── 2. Contacts without linkedin_url ──
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, company, title, email")
      .is("linkedin_url", null)
      .not("first_name", "is", null)
      .not("last_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE);

    if (contacts?.length) {
      logger.info(`Looking up LinkedIn for ${contacts.length} contacts`);
      // Map contact fields to match candidate shape
      const mapped = contacts.map((c: any) => ({
        ...c,
        current_company: c.company,
        current_title: c.title,
      }));
      const result = await lookupBatch(supabase, baseUrl, apiKey, mapped, "contacts");
      found += result.found;
      notFound += result.notFound;
      skipped += result.skipped;
    }

    const summary = { found, notFound, skipped };
    logger.info("LinkedIn lookup complete", summary);
    return summary;
  },
});

async function lookupBatch(
  supabase: any,
  baseUrl: string,
  apiKey: string,
  records: any[],
  table: "candidates" | "contacts",
): Promise<{ found: number; notFound: number; skipped: number }> {
  let found = 0;
  let notFound = 0;
  let skipped = 0;

  for (const record of records) {
    const name = `${record.first_name} ${record.last_name}`.trim();
    if (!name || name.length < 3) {
      skipped++;
      continue;
    }

    try {
      let keywords = name;
      if (record.current_company) {
        keywords += ` ${record.current_company}`;
      }

      const searchUrl = `${baseUrl}/users/search?keywords=${encodeURIComponent(keywords)}&limit=3`;
      const resp = await fetch(searchUrl, {
        headers: { "X-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        logger.warn("Search API error", { id: record.id, table, status: resp.status });
        notFound++;
        await delay(DELAY_MS);
        continue;
      }

      const data = await resp.json();
      const results = data.items || data || [];
      const match = findBestMatch(results, record);

      if (match) {
        const linkedinUrl = match.linkedin_url || match.public_profile_url ||
          (match.provider_id ? `https://www.linkedin.com/in/${match.provider_id}` : null);

        const update: Record<string, any> = {};
        if (linkedinUrl) update.linkedin_url = linkedinUrl;
        if (match.profile_picture_url || match.picture_url) {
          update.avatar_url = match.profile_picture_url || match.picture_url;
        }

        if (table === "candidates") {
          if (match.provider_id) update.unipile_provider_id = match.provider_id;
          if (match.headline) update.linkedin_headline = match.headline;
          if (match.current_company && !record.current_company) update.current_company = match.current_company;
          if (match.current_title && !record.current_title) update.current_title = match.current_title;
        } else {
          if (match.current_company && !record.current_company) update.company = match.current_company;
          if (match.current_title && !record.current_title) update.title = match.current_title;
        }

        if (Object.keys(update).length > 0) {
          await supabase.from(table).update(update as any).eq("id", record.id);
          found++;
          logger.info("LinkedIn match found", { id: record.id, table, name, linkedinUrl });
        }
      } else {
        notFound++;
      }

      await delay(DELAY_MS);
    } catch (err: any) {
      logger.warn("Lookup failed", { id: record.id, table, error: err.message });
      notFound++;
    }
  }

  return { found, notFound, skipped };
}

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
