import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting } from "./lib/supabase";
import { unipileFetch } from "./lib/unipile-v2";

/**
 * Push the team's preferred Unipile auto-proxy anchor onto every
 * connected LinkedIn account.
 *
 * Reads `app_settings.UNIPILE_AUTO_PROXY_IP` (e.g. the office's WAN
 * IP — Unipile picks a proxy near it, which gets us location-precise
 * routing without paying for a custom proxy provider). Falls back to
 * `UNIPILE_AUTO_PROXY_COUNTRY` when no IP is set.
 *
 *   PATCH /api/v2/{account_id}/proxy
 *   body: { ip: "..." }   OR   { country: "US" }
 *
 * Auto-proxies cover LinkedIn, WhatsApp, Instagram on Unipile's side.
 * Outlook accounts are skipped — Unipile doesn't offer auto-proxy for
 * email providers.
 *
 * Run modes:
 *   - Manual: dispatch `sync-proxy-config-once` from the dashboard
 *     (no payload) to re-stamp every active LinkedIn account
 *   - Daily: `sync-proxy-config-daily` runs at 07:00 UTC and just
 *     re-applies the config (idempotent — Unipile no-ops when the
 *     anchor matches the existing one)
 */

async function applyProxyConfig(): Promise<{
  applied: number; skipped: number; errors: number; via: "ip" | "country" | null;
}> {
  const supabase = getSupabaseAdmin();
  const ip = (await getAppSetting("UNIPILE_AUTO_PROXY_IP").catch(() => "")).trim();
  const country = (await getAppSetting("UNIPILE_AUTO_PROXY_COUNTRY").catch(() => "")).trim();

  const body: Record<string, string> = {};
  let via: "ip" | "country" | null = null;
  if (ip) { body.ip = ip; via = "ip"; }
  else if (country) { body.country = country; via = "country"; }
  else {
    logger.warn("No proxy preference set — set UNIPILE_AUTO_PROXY_IP or UNIPILE_AUTO_PROXY_COUNTRY in app_settings");
    return { applied: 0, skipped: 0, errors: 0, via: null };
  }

  // Pull every active LinkedIn account. Auto-proxy doesn't apply to
  // Outlook/email so we skip the email rows entirely.
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, account_label, account_type, unipile_account_id")
    .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .like("unipile_account_id", "acc_%");

  let applied = 0, skipped = 0, errors = 0;
  for (const acct of accounts ?? []) {
    try {
      await unipileFetch(supabase, acct.unipile_account_id!, `proxy`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      applied++;
      logger.info("Proxy anchor applied", {
        account: acct.account_label, type: acct.account_type, via, ...body,
      });
    } catch (err: any) {
      errors++;
      logger.warn("Proxy update failed (non-fatal)", {
        account: acct.account_label, error: err.message,
      });
    }
  }

  logger.info("Proxy sync complete", { applied, skipped, errors, via, ...body });
  return { applied, skipped, errors, via };
}

/** Manual one-shot — dispatch from the Trigger.dev dashboard. */
export const syncProxyConfigOnce = task({
  id: "sync-proxy-config-once",
  maxDuration: 180,
  retry: { maxAttempts: 1 },
  run: () => applyProxyConfig(),
});

/** Daily sweep — keeps the anchor consistent if Unipile rotates it. */
export const syncProxyConfigDaily = schedules.task({
  id: "sync-proxy-config-daily",
  cron: "0 7 * * *", // 07:00 UTC
  maxDuration: 180,
  run: () => applyProxyConfig(),
});
