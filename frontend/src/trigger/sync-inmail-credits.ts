import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch } from "./lib/unipile-v2";

/**
 * Pull each LinkedIn Recruiter account's remaining InMail credits and
 * stamp them on integration_accounts. Lets the UI show a "12 InMails
 * left" badge and lets sendLinkedIn block InMail sends when the well
 * is dry instead of waiting for Unipile to 422.
 *
 * v2 path:
 *   GET /api/v2/{account_id}/linkedin/recruiter/inmail-credits
 *
 * Response shape varies a little across Unipile builds, so we look at
 * a small list of common keys (remaining/credits/balance).
 *
 * Schedule: every hour. Cheaper than every send and credits change
 * slowly enough that a 60-min stale read is harmless.
 */
export const syncInmailCredits = schedules.task({
  id: "sync-inmail-credits",
  cron: "0 * * * *",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, account_label")
      .eq("account_type", "linkedin_recruiter")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      logger.info("No active linkedin_recruiter accounts — skipping credits sync");
      return { checked: 0, updated: 0 };
    }

    let checked = 0;
    let updated = 0;
    const summary: Array<{ label: string; remaining: number | null; total: number | null }> = [];

    for (const acct of accounts) {
      checked++;
      try {
        const data: any = await unipileFetch(
          supabase,
          acct.unipile_account_id!,
          `linkedin/recruiter/inmail-credits`,
          { method: "GET" },
        );

        // Unipile sometimes returns a flat object, sometimes nests under
        // `credits`. Normalize across both shapes.
        const credits = data?.credits ?? data ?? {};
        const remaining =
          credits.remaining ?? credits.available ?? credits.balance ?? null;
        const total = credits.total ?? credits.allotted ?? credits.quota ?? null;

        await supabase
          .from("integration_accounts")
          .update({
            inmail_credits_remaining: remaining,
            inmail_credits_total: total,
            inmail_credits_updated_at: new Date().toISOString(),
          } as any)
          .eq("id", acct.id);

        updated++;
        summary.push({
          label: acct.account_label || acct.id,
          remaining: remaining as number | null,
          total: total as number | null,
        });
      } catch (err: any) {
        logger.warn("InMail credits fetch failed (non-fatal)", {
          account: acct.account_label,
          error: err.message,
        });
      }
    }

    logger.info("InMail credits sync complete", { checked, updated, summary });
    return { checked, updated, summary };
  },
});
