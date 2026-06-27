import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { unipileFetch } from "../../../../src/server-lib/unipile-v2.js";

/**
 * Push the team's preferred Unipile auto-proxy anchor onto every active
 * LinkedIn account.
 *
 * Reads `app_settings.UNIPILE_AUTO_PROXY_IP` (e.g. the office WAN IP —
 * Unipile picks a proxy near it for location-precise routing). Falls
 * back to `UNIPILE_AUTO_PROXY_COUNTRY` when no IP is set.
 *
 * The proxy anchor endpoint is v2-only
 * (PATCH /v2/{account_id}/proxy) and our v2 app key returns 403
 * Insufficient permissions on it. v1 has no equivalent — proxy
 * routing is set at tenant-creation time. Until Unipile widens our
 * v2 scope this job is a no-op; left in place so the cron history /
 * scheduling don't reset when the scope is finally granted.
 *
 * Outlook accounts are skipped — Unipile doesn't offer auto-proxy for
 * email providers.
 *
 * Daily at 07:00 UTC. Also exposes an event-triggered one-off variant
 * for manual re-stamps:
 *   await inngest.send({ name: "ops/sync-proxy-config.requested" });
 *
 * Ported from `src/trigger/sync-proxy-config.ts` — Inngest is the only
 * scheduler now.
 */

async function applyProxyConfig(logger: any): Promise<{
  applied: number;
  skipped: number;
  errors: number;
  via: "ip" | "country" | null;
}> {
  const supabase = getSupabaseAdmin();
  const ip = (await getAppSetting("UNIPILE_AUTO_PROXY_IP").catch(() => "")).trim();
  const country = (await getAppSetting("UNIPILE_AUTO_PROXY_COUNTRY").catch(() => "")).trim();

  const body: Record<string, string> = {};
  let via: "ip" | "country" | null = null;
  if (ip) {
    body.ip = ip;
    via = "ip";
  } else if (country) {
    body.country = country;
    via = "country";
  } else {
    logger.warn(
      "No proxy preference set — set UNIPILE_AUTO_PROXY_IP or UNIPILE_AUTO_PROXY_COUNTRY in app_settings",
    );
    return { applied: 0, skipped: 0, errors: 0, via: null };
  }

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, account_label, account_type, unipile_account_id")
    .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .like("unipile_account_id", "acc_%");

  let applied = 0;
  let errors = 0;
  const skipped = 0;
  for (const acct of accounts ?? []) {
    try {
      await unipileFetch(supabase, acct.unipile_account_id!, `proxy`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      applied++;
      logger.info("Proxy anchor applied", {
        account: acct.account_label,
        type: acct.account_type,
        via,
        ...body,
      });
    } catch (err: any) {
      errors++;
      logger.warn("Proxy update failed (non-fatal)", {
        account: acct.account_label,
        error: err.message,
      });
    }
  }

  logger.info("Proxy sync complete", { applied, skipped, errors, via, ...body });
  return { applied, skipped, errors, via };
}

export const syncProxyConfigDaily = inngest.createFunction(
  { id: "sync-proxy-config-daily", name: "Apply Unipile proxy anchor (daily, Inngest)" },
  { cron: "0 7 * * *" },
  async ({ logger }) => applyProxyConfig(logger),
);

export const syncProxyConfigOnce = inngest.createFunction(
  { id: "sync-proxy-config-once", name: "Apply Unipile proxy anchor (one-off, Inngest)" },
  { event: "ops/sync-proxy-config.requested" },
  async ({ logger }) => applyProxyConfig(logger),
);
