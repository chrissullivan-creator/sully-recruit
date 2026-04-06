import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

/**
 * Scheduled task: monitor InMail credit balance.
 *
 * Checks remaining InMail credits and creates an alert task
 * when credits are running low (< 10 remaining).
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: monitor-inmail-credits
 *   Cron: 0 8 * * 1 (weekly, Monday 8 AM UTC)
 */
export const monitorInmailCredits = schedules.task({
  id: "monitor-inmail-credits",
  maxDuration: 60,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, owner_user_id, account_label")
      .or("account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter,account_type.eq.sales_navigator")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      logger.info("No Recruiter/Sales Nav accounts to check");
      return { accounts_checked: 0 };
    }

    const results: Array<{ account: string; credits: number | null; alert: boolean }> = [];

    for (const account of accounts) {

      try {
        const resp = await fetch(
          `${baseUrl}/inmail/credits?account_id=${account.unipile_account_id}`,
          {
            headers: { "X-API-KEY": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
          },
        );

        if (!resp.ok) {
          results.push({ account: account.account_label || account.id, credits: null, alert: false });
          continue;
        }

        const data = await resp.json();
        const credits = data.credits ?? data.remaining ?? data.inmail_credits ?? null;

        const needsAlert = typeof credits === "number" && credits < 10;

        if (needsAlert) {
          await supabase.from("tasks").insert({
            title: `Low InMail credits: ${credits} remaining`,
            description: `LinkedIn account "${account.account_label || "Recruiter/Sales Nav"}" has only ${credits} InMail credits left. Consider upgrading or pacing outreach.`,
            task_type: "alert",
            priority: "high",
            status: "pending",
            assigned_to: account.owner_user_id,
            due_date: new Date().toISOString(),
          } as any);

          logger.warn("Low InMail credits", { accountId: account.id, credits });
        }

        results.push({
          account: account.account_label || account.id,
          credits,
          alert: needsAlert,
        });
      } catch (err: any) {
        logger.warn("InMail credit check failed", { accountId: account.id, error: err.message });
        results.push({ account: account.account_label || account.id, credits: null, alert: false });
      }
    }

    logger.info("InMail credit check complete", { results });
    return { accounts_checked: results.length, results };
  },
});
