import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting } from "./lib/supabase";

const BATCH_SIZE = 100;
const DELAY_MS = 500; // ~2 requests/second to avoid Unipile rate limits

/**
 * Scheduled task: backfill company and title info for candidates/contacts.
 *
 * Two modes:
 *   - local: parse linkedin_profile_data JSON already stored in DB
 *   - api:   call Unipile for profiles that don't have stored data
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: backfill-companies
 *   Cron: 0 4 * * * (daily at 4 AM UTC)
 */
export const backfillCompanies = schedules.task({
  id: "backfill-companies",
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Run local mode first (fast, no API calls)
    const candidatesLocal = await backfillFromLocal(supabase, "candidates", BATCH_SIZE);
    const contactsLocal = await backfillFromLocal(supabase, "contacts", BATCH_SIZE);

    // Then run API mode for remaining records
    const accountId = await resolveAccountId(supabase);
    let candidatesApi = { total: 0, updated: 0, failed: 0 };
    let contactsApi = { total: 0, updated: 0, failed: 0 };

    if (accountId) {
      let unipileApiKey: string | undefined;
      try {
        unipileApiKey = await getAppSetting("UNIPILE_API_KEY");
      } catch {
        logger.warn("No UNIPILE_API_KEY in app_settings — skipping API mode");
      }

      if (unipileApiKey) {
        candidatesApi = await backfillFromApi(supabase, "candidates", BATCH_SIZE, accountId, unipileApiKey);
        contactsApi = await backfillFromApi(supabase, "contacts", BATCH_SIZE, accountId, unipileApiKey);
      }
    } else {
      logger.warn("No active Unipile account found — skipping API mode");
    }

    const summary = {
      local: { candidates: candidatesLocal, contacts: contactsLocal },
      api: { candidates: candidatesApi, contacts: contactsApi },
    };

    logger.info("Backfill complete", summary);
    return summary;
  },
});

// ─── Local mode: parse company from linkedin_profile_data already in DB ──────

async function backfillFromLocal(supabase: any, table: string, limit: number) {
  const companyCol = table === "candidates" ? "current_company" : "company_name";
  const titleCol = table === "candidates" ? "current_title" : "title";

  const { data: records, error } = await supabase
    .from(table)
    .select(`id, ${companyCol}, ${titleCol}, linkedin_profile_data`)
    .not("linkedin_profile_data", "is", null)
    .or(`${companyCol}.is.null,${companyCol}.eq.`)
    .limit(limit);

  if (error) {
    logger.error(`Failed to query ${table}:`, { error: error.message });
    return { total: 0, updated: 0, skipped: 0 };
  }

  let updated = 0;
  let skipped = 0;

  for (const rec of records ?? []) {
    try {
      const profileJson =
        typeof rec.linkedin_profile_data === "string"
          ? JSON.parse(rec.linkedin_profile_data)
          : rec.linkedin_profile_data;

      const company = extractCompanyFromProfile(profileJson);
      const title = extractTitleFromProfile(profileJson);

      const updates: Record<string, string> = {};
      if (company && !rec[companyCol]) updates[companyCol] = company;
      if (title && !rec[titleCol]) updates[titleCol] = title;

      if (Object.keys(updates).length > 0) {
        await supabase.from(table).update(updates).eq("id", rec.id);
        updated++;
      } else {
        skipped++;
      }
    } catch (err: any) {
      logger.warn(`Parse error ${rec.id}: ${err.message}`);
      skipped++;
    }
  }

  return { total: records?.length ?? 0, updated, skipped };
}

// ─── API mode: call Unipile for profiles not yet in DB ───────────────────────

async function backfillFromApi(
  supabase: any,
  table: string,
  limit: number,
  accountId: string,
  apiKey: string,
) {
  const companyCol = table === "candidates" ? "current_company" : "company_name";
  const titleCol = table === "candidates" ? "current_title" : "title";
  const baseUrl = "https://api19.unipile.com:14926/api/v1";

  const { data: records, error } = await supabase
    .from(table)
    .select(`id, linkedin_url, ${companyCol}, ${titleCol}`)
    .not("linkedin_url", "is", null)
    .is("linkedin_profile_data", null)
    .or(`${companyCol}.is.null,${companyCol}.eq.`)
    .limit(limit);

  if (error) return { total: 0, updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;

  for (const rec of records ?? []) {
    const providerId = extractLinkedInId(rec.linkedin_url);
    if (!providerId) {
      failed++;
      continue;
    }

    try {
      const url = `${baseUrl}/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: { "X-API-KEY": apiKey } });

      if (!res.ok) {
        failed++;
        await delay(DELAY_MS);
        continue;
      }

      const profile = await res.json();

      // Store raw profile data for future local mode runs
      await supabase
        .from(table)
        .update({ linkedin_profile_data: JSON.stringify(profile) })
        .eq("id", rec.id);

      const company = extractCompanyFromProfile(profile);
      const title = extractTitleFromProfile(profile);

      const updates: Record<string, string> = {};
      if (company) updates[companyCol] = company;
      if (title && !rec[titleCol]) updates[titleCol] = title;

      if (Object.keys(updates).length > 0) {
        await supabase.from(table).update(updates).eq("id", rec.id);
        updated++;
      } else {
        failed++;
      }

      await delay(DELAY_MS);
    } catch (err: any) {
      logger.warn(`API error for ${providerId}: ${err.message}`);
      failed++;
    }
  }

  return { total: records?.length ?? 0, updated, failed };
}

// ─── Profile parsing helpers ─────────────────────────────────────────────────

function extractCompanyFromProfile(p: any): string | null {
  const positions: any[] = p.positions ?? p.experience ?? p.work_experience ?? p.jobs ?? [];
  if (positions.length > 0) {
    const current =
      positions.find((pos: any) => pos.is_current === true || pos.current === true || !pos.end_date) ??
      positions[0];
    const company = current?.company?.name ?? current?.company_name ?? current?.organization ?? null;
    if (company) return company;
  }

  const headline = p.headline ?? "";
  if (headline.includes(" at ")) {
    const parts = headline.split(" at ");
    const company = parts[parts.length - 1].trim();
    if (company && company.length > 1) return company;
  }

  for (const sep of [" | ", " - ", " — "]) {
    if (headline.includes(sep)) {
      const parts = headline.split(sep);
      if (parts.length >= 2) {
        const candidate = parts[parts.length - 1].trim();
        if (candidate && candidate[0] === candidate[0].toUpperCase() && candidate.length > 1) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function extractTitleFromProfile(p: any): string | null {
  const positions: any[] = p.positions ?? p.experience ?? p.work_experience ?? p.jobs ?? [];
  if (positions.length > 0) {
    const current =
      positions.find((pos: any) => pos.is_current === true || pos.current === true || !pos.end_date) ??
      positions[0];
    return current?.title ?? current?.role ?? null;
  }

  const headline = p.headline ?? "";
  if (headline.includes(" at ")) {
    return headline.split(" at ")[0].trim() || null;
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLinkedInId(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function resolveAccountId(supabase: any): Promise<string | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id")
    .not("unipile_account_id", "is", null)
    .eq("is_active", true)
    .limit(1);
  return data?.[0]?.unipile_account_id ?? null;
}
