/**
 * Check remaining credits for each enrichment provider every 6 hours.
 * Emails CREDIT_ALERT_RECIPIENTS (seeded with the project owner's
 * address) the moment any provider's balance hits its configured
 * threshold (default 5).
 *
 * Anti-spam: after sending an alert we won't re-alert for the same
 * provider for 24 hours UNLESS the balance has dropped further since
 * the last alert. That way "5 → 4" still pages, but a stuck "0 → 0"
 * doesn't email every 6 hours.
 *
 * Per-provider balance fetchers live on each integration client. They
 * return null on any failure (timeout, parse error, expired key) —
 * the cron records `last_error` on the state row so the operator sees
 * which provider needs attention without firing an alert.
 *
 * Config lives in two tables:
 *   provider_credit_state  — per-provider threshold, enabled flag,
 *                            last-known balance, dedup stamps.
 *   app_settings           — CREDIT_ALERT_RECIPIENTS (comma-separated),
 *                            ALERT_SENDER (reused from alerting.ts).
 */

import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { sendInternalEmail } from "../../../../src/server-lib/microsoft-graph.js";
import { getApolloConfig, apolloGetCredits } from "../../integrations/apollo.js";
import { getBetterContactConfig, betterContactGetCredits } from "../../integrations/bettercontact.js";
import { getFullEnrichConfig, fullEnrichGetCredits } from "../../integrations/fullenrich.js";
import { getPdlConfig, pdlGetCredits } from "../../integrations/pdl.js";
import { getZeroBounceConfig, zerobounceGetCredits } from "../../integrations/zerobounce.js";

type Provider = "apollo" | "bettercontact" | "fullenrich" | "pdl" | "zerobounce";

const PROVIDER_LABELS: Record<Provider, string> = {
  apollo: "Apollo",
  bettercontact: "BetterContact",
  fullenrich: "FullEnrich",
  pdl: "People Data Labs",
  zerobounce: "ZeroBounce",
};

const RE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface ProviderResult {
  provider: Provider;
  balance: number | null;
  threshold: number;
  error: string | null;
  should_alert: boolean;
  /** Last balance we alerted on, if any — used to decide "balance dropped → re-alert" even within cooldown. */
  last_alert_balance: number | null;
  last_alert_sent_at: string | null;
}

async function fetchBalance(
  provider: Provider,
  supabase: any,
): Promise<{ balance: number | null; error: string | null; key_present: boolean }> {
  try {
    switch (provider) {
      case "apollo": {
        const cfg = await getApolloConfig(supabase);
        if (!cfg) return { balance: null, error: null, key_present: false };
        return { balance: await apolloGetCredits(cfg), error: null, key_present: true };
      }
      case "bettercontact": {
        const cfg = await getBetterContactConfig(supabase);
        if (!cfg) return { balance: null, error: null, key_present: false };
        return { balance: await betterContactGetCredits(cfg), error: null, key_present: true };
      }
      case "fullenrich": {
        const cfg = await getFullEnrichConfig(supabase);
        if (!cfg) return { balance: null, error: null, key_present: false };
        return { balance: await fullEnrichGetCredits(cfg), error: null, key_present: true };
      }
      case "pdl": {
        const cfg = await getPdlConfig(supabase);
        if (!cfg) return { balance: null, error: null, key_present: false };
        return { balance: await pdlGetCredits(cfg), error: null, key_present: true };
      }
      case "zerobounce": {
        const cfg = await getZeroBounceConfig(supabase);
        if (!cfg) return { balance: null, error: null, key_present: false };
        return { balance: await zerobounceGetCredits(cfg), error: null, key_present: true };
      }
    }
  } catch (err: any) {
    return { balance: null, error: err?.message?.slice(0, 200) ?? "unknown", key_present: true };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function runCreditCheck(logger: any) {
    const supabase = getSupabaseAdmin();

    // Load per-provider config + last-alert state in one query.
    const { data: stateRows } = await supabase
      .from("provider_credit_state")
      .select("*");
    const stateByProvider = new Map<string, any>(
      (stateRows ?? []).map((r: any) => [r.provider, r]),
    );

    const providers: Provider[] = ["apollo", "bettercontact", "fullenrich", "pdl", "zerobounce"];
    const results: ProviderResult[] = [];

    for (const provider of providers) {
      const state = stateByProvider.get(provider);
      if (state && state.enabled === false) continue;
      const threshold = Number(state?.threshold ?? 5);

      const { balance, error, key_present } = await fetchBalance(provider, supabase);
      if (!key_present) {
        // Don't alert on missing keys — operator may have intentionally
        // not configured a provider.
        continue;
      }

      // Update state row regardless of alert decision.
      const upd: Record<string, any> = {
        provider,
        last_balance: balance,
        last_balance_unit: "credits",
        last_checked_at: new Date().toISOString(),
        last_error: error,
        threshold,
      };
      const { error: stateErr } = await supabase
        .from("provider_credit_state")
        .upsert(upd, { onConflict: "provider" });
      if (stateErr) logger.warn("credit-state upsert failed", { provider, err: stateErr.message });

      // Decide whether to alert.
      let shouldAlert = false;
      if (balance != null && balance <= threshold) {
        const lastAlertAt = state?.last_alert_sent_at
          ? new Date(state.last_alert_sent_at).getTime()
          : 0;
        const cooldownElapsed = Date.now() - lastAlertAt > RE_ALERT_COOLDOWN_MS;
        const lastAlertBalance = state?.last_alert_balance == null
          ? null : Number(state.last_alert_balance);
        const droppedFurther = lastAlertBalance != null && balance < lastAlertBalance;
        if (cooldownElapsed || droppedFurther || lastAlertAt === 0) {
          shouldAlert = true;
        }
      }

      results.push({
        provider, balance, threshold, error,
        should_alert: shouldAlert,
        last_alert_balance: state?.last_alert_balance ?? null,
        last_alert_sent_at: state?.last_alert_sent_at ?? null,
      });
    }

    const lows = results.filter((r) => r.should_alert);
    if (lows.length === 0) {
      return { checked: results.length, low: 0, alerted: 0 };
    }

    // Load alert settings.
    const { data: settingRows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["CREDIT_ALERT_RECIPIENTS", "ALERT_SENDER"]);
    const byKey: Record<string, string> = {};
    for (const r of settingRows ?? []) byKey[r.key] = r.value || "";
    const recipients = (byKey.CREDIT_ALERT_RECIPIENTS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const sender = byKey.ALERT_SENDER || "";
    if (!sender || recipients.length === 0) {
      logger.warn("credit alert needed but ALERT_SENDER or CREDIT_ALERT_RECIPIENTS missing", {
        low: lows.map((l) => `${l.provider}:${l.balance}`),
      });
      return { checked: results.length, low: lows.length, alerted: 0, error: "sender/recipients not configured" };
    }

    // Single batched email — easier to scan than five separate alerts.
    const subject = `[Sully Recruit] ${lows.length} enrichment provider${lows.length === 1 ? "" : "s"} low on credits`;
    const rowsHtml = results.map((r) => `
      <tr style="${r.should_alert ? "background:#fef2f2" : ""}">
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(PROVIDER_LABELS[r.provider])}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace">
          ${r.balance == null ? "—" : r.balance}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280">
          ≤ ${r.threshold}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:${r.should_alert ? "#dc2626" : "#6b7280"}">
          ${r.error ? `error: ${escapeHtml(r.error)}` : r.should_alert ? "LOW" : "ok"}
        </td>
      </tr>
    `).join("");

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px">
        <h2 style="margin:0 0 4px 0;color:#dc2626">Enrichment credits low</h2>
        <p style="color:#6b7280;margin:0 0 16px 0">
          ${lows.length} of ${results.length} provider${results.length === 1 ? "" : "s"} hit their alert threshold.
          Top up at the provider dashboard — the cascade will silently fail through to the next provider until you do.
        </p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <thead>
            <tr style="background:#f9fafb;text-align:left">
              <th style="padding:6px 10px;border-bottom:1px solid #e5e7eb">Provider</th>
              <th style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">Balance</th>
              <th style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">Threshold</th>
              <th style="padding:6px 10px;border-bottom:1px solid #e5e7eb">Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:16px">
          Anti-spam: next alert for the same provider in 24h unless balance drops further.
          Change thresholds or disable a provider in <code>provider_credit_state</code>.
        </p>
      </div>`;

    try {
      await sendInternalEmail(sender, recipients, subject, html);
    } catch (err: any) {
      logger.warn("credit alert email failed", { error: err?.message });
      return { checked: results.length, low: lows.length, alerted: 0, error: "email send failed" };
    }

    // Stamp last_alert_sent_at + last_alert_balance for the providers we alerted.
    const now = new Date().toISOString();
    for (const low of lows) {
      await supabase
        .from("provider_credit_state")
        .update({
          last_alert_sent_at: now,
          last_alert_balance: low.balance,
        })
        .eq("provider", low.provider);
    }

    return { checked: results.length, low: lows.length, alerted: lows.length };
}

export const checkEnrichmentCredits = inngest.createFunction(
  { id: "check-enrichment-credits", name: "Check enrichment-provider credits (every 6h)" },
  { cron: "0 */6 * * *" },
  async ({ logger }) => runCreditCheck(logger),
);

/** Manual one-off trigger — fire `ops/check-enrichment-credits.requested`. */
export const checkEnrichmentCreditsOnce = inngest.createFunction(
  { id: "check-enrichment-credits-once", name: "Check enrichment-provider credits (one-off)" },
  { event: "ops/check-enrichment-credits.requested" },
  async ({ logger }) => runCreditCheck(logger),
);
