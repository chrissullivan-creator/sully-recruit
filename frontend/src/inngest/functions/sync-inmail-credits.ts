import { inngest } from "../client";
// Relative imports — the api/inngest serve route bundles this file
// for Vercel, and Vercel's serverless bundler doesn't apply the
// tsconfig `@/*` path alias the same way Vite does for src/. Keeping
// these relative avoids ERR_MODULE_NOT_FOUND at deploy time.
import { getSupabaseAdmin } from "../../trigger/lib/supabase";
import { unipileFetch } from "../../trigger/lib/unipile-v2";

/**
 * Hourly LinkedIn Recruiter InMail credit sync.
 *
 * Pulls remaining credits from Unipile per active linkedin_recruiter
 * account and stamps them on integration_accounts. Lets the UI show a
 * "12 InMails left" badge and lets sendLinkedIn block InMail sends
 * before Unipile 422s.
 *
 * v2 path: GET /api/v2/{account_id}/linkedin/recruiter/inmail-credits
 *
 * Migrated from frontend/src/trigger/sync-inmail-credits.ts as the
 * canonical Inngest pattern (small, idempotent, no fan-out beyond the
 * per-account loop). Cron expression matches the Trigger.dev original
 * exactly so the schedule doesn't shift on cutover.
 */
export const syncInmailCredits = inngest.createFunction(
  {
    id: "sync-inmail-credits",
    retries: 1,
    triggers: [
      { cron: "0 * * * *" },
      { event: "infra/sync-inmail-credits.requested" },
    ],
  },
  async ({ step, logger }) => {
    const supabase = getSupabaseAdmin();

    const accounts = await step.run("load-accounts", async () => {
      const { data } = await supabase
        .from("integration_accounts")
        .select("id, unipile_account_id, account_label")
        .eq("account_type", "linkedin_recruiter")
        .eq("is_active", true)
        .not("unipile_account_id", "is", null);
      return data ?? [];
    });

    if (accounts.length === 0) {
      logger.info("No active linkedin_recruiter accounts — skipping credits sync");
      return { checked: 0, updated: 0 };
    }

    let updated = 0;
    const summary: Array<{ label: string; remaining: number | null; total: number | null }> = [];

    for (const acct of accounts) {
      // Per-account step.run — Inngest memoises each step's result,
      // so a transient failure on account 3 of 5 only retries account
      // 3 instead of restarting the whole sweep and re-billing the
      // first two API calls.
      const result = await step.run(`sync-${acct.id}`, async () => {
        try {
          const data: any = await unipileFetch(
            supabase,
            acct.unipile_account_id!,
            `linkedin/recruiter/inmail-credits`,
            { method: "GET" },
          );
          // Unipile sometimes returns a flat object, sometimes nests
          // under `credits`. Normalise across both shapes — same logic
          // as the Trigger.dev source.
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

          return {
            ok: true as const,
            label: acct.account_label || acct.id,
            remaining,
            total,
          };
        } catch (err: any) {
          // Don't fail the whole function for one account — the others
          // should still update. Trigger.dev original used a try/catch
          // with logger.warn for the same reason.
          return { ok: false as const, label: acct.account_label || acct.id, error: err?.message };
        }
      });

      // step.run jsonifies its return; the discriminated union narrows
      // through the `ok` flag at runtime even after serialisation.
      if (result.ok === true) {
        updated++;
        summary.push({
          label: result.label,
          remaining: (result as { remaining: number | null }).remaining,
          total: (result as { total: number | null }).total,
        });
      } else {
        logger.warn("InMail credits fetch failed (non-fatal)", {
          account: result.label,
          error: (result as { error?: string }).error,
        });
      }
    }

    logger.info("InMail credits sync complete", {
      checked: accounts.length,
      updated,
      summary,
    });
    return { checked: accounts.length, updated, summary };
  },
);
