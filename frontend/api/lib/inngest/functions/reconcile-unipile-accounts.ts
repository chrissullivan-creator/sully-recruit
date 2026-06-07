import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { normalizeEmail } from "../../../../src/server-lib/resume-parsing.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Self-heal for Unipile account drift — the failure that silently froze
 * inbound email for ~3 weeks in May/June 2026.
 *
 * Root cause it guards against: when a mailbox (or LinkedIn account) is
 * re-linked in the Unipile dashboard, Unipile mints a BRAND NEW `acc_xxx`
 * id. Nothing was updating `integration_accounts.unipile_account_id`, so the
 * backfill cron + the real-time webhook matcher kept calling the OLD, dead id
 * → every pull 404'd → email quietly stopped with no alert.
 *
 * Every 15 minutes this:
 *   1. Lists the LIVE Unipile accounts (GET {v2Base}/accounts — the mailboxes
 *      live on the v2 app; the v1 DSN workspace is empty).
 *   2. For each email mailbox in integration_accounts:
 *      - stored id still live  → just check health; alert if it's unhealthy
 *        (CREDENTIALS/STOPPED/etc. — the "needs reconnect" case).
 *      - stored id gone (drift) → find the live account with the SAME email
 *        address and auto-correct the stored id + reactivate (the self-heal).
 *      - no live account for that email → the mailbox is genuinely
 *        disconnected → alert so a human reconnects it.
 *
 * Safety: the only write (correcting the id) fires solely on a positive
 * email match, so a parsing miss degrades to a harmless alert, never a wrong
 * update. It NEVER deactivates an account, and it bails without touching
 * anything if Unipile is unreachable (could be a transient outage). Alerts
 * are de-duped 1/hour per signature by notifyError.
 *
 * Scoped to email accounts: email address is a clean, unambiguous match key.
 * LinkedIn drift (matched by name/identifier) is intentionally out of scope.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Deep-scan an arbitrary account object for any email-looking strings —
 *  robust to whichever field Unipile parks the address in. */
function collectEmails(obj: any, out: Set<string>, depth = 0): void {
  if (obj == null || depth > 6) return;
  if (typeof obj === "string") {
    const matches = obj.match(EMAIL_RE);
    if (matches) for (const m of matches) out.add(m.toLowerCase());
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectEmails(v, out, depth + 1);
    return;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) collectEmails(obj[k], out, depth + 1);
  }
}

/** Conservative health read: unhealthy only when an explicitly-bad status
 *  marker is present anywhere on the account (sources[].status, status,
 *  connection_status). Unknown → treated as healthy so we never false-alarm. */
function accountHealth(acct: any): { healthy: boolean; status: string } {
  const statuses: string[] = [];
  const sources = Array.isArray(acct?.sources) ? acct.sources : [];
  for (const s of sources) if (s?.status) statuses.push(String(s.status));
  if (acct?.status) statuses.push(String(acct.status));
  if (acct?.connection_status) statuses.push(String(acct.connection_status));
  const text = statuses.join(",").toUpperCase();
  const bad = /CREDENTIALS|ERROR|STOPPED|DISCONNECT|EXPIRED|DELETED|FAILED|PAUSED/.test(text);
  return { healthy: !bad, status: statuses.join(",") || "unknown" };
}

async function fetchLiveAccounts(base: string, apiKey: string): Promise<any[]> {
  const all: any[] = [];
  let url: string | null = `${base}/accounts?limit=255`;
  let guard = 0;
  while (url && guard++ < 10) {
    const resp = await fetch(url, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`Unipile GET /accounts failed: HTTP ${resp.status}`);
    const data: any = await resp.json();
    const items: any[] = Array.isArray(data) ? data : (data.items ?? data.accounts ?? data.data ?? []);
    all.push(...items);
    const cursor = data?.cursor || data?.next_cursor || null;
    url = cursor ? `${base}/accounts?limit=255&cursor=${encodeURIComponent(cursor)}` : null;
  }
  return all;
}

export const reconcileUnipileAccounts = inngest.createFunction(
  { id: "reconcile-unipile-accounts", name: "Reconcile Unipile account IDs + alert on disconnect", retries: 1 },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    // The mailboxes live on the Unipile **v2** app (the v1 DSN workspace is
    // empty), so reconcile against v2 /accounts with the v2 key and heal the
    // canonical acc_xxx into integration_accounts.unipile_account_id_v2.
    const base =
      ((await getAppSetting("UNIPILE_BASE_V2_URL")) || "").replace(/\/+$/, "") ||
      "https://api.unipile.com/v2";
    const apiKey = (await getAppSetting("UNIPILE_API_KEY_V2")) || (await getAppSetting("UNIPILE_API_KEY"));
    if (!apiKey) {
      logger.error("reconcile-unipile-accounts: UNIPILE_API_KEY_V2 missing");
      return { error: "no_api_key" };
    }

    // If Unipile is unreachable we do NOTHING — never deactivate/alert-storm
    // on a transient outage.
    let live: any[];
    try {
      live = await fetchLiveAccounts(base, apiKey);
    } catch (err: any) {
      logger.error("reconcile-unipile-accounts: list failed", { error: err.message });
      await notifyError({ taskId: "reconcile-unipile-accounts", severity: "WARN", error: err });
      return { error: err.message };
    }

    const liveIds = new Set<string>();
    const healthById = new Map<string, { healthy: boolean; status: string }>();
    const emailToAccount = new Map<string, { id: string; healthy: boolean; status: string }>();
    for (const acct of live) {
      const id = acct?.id;
      if (!id) continue;
      liveIds.add(id);
      const health = accountHealth(acct);
      healthById.set(id, health);
      const emails = new Set<string>();
      collectEmails(acct, emails);
      for (const e of emails) {
        const existing = emailToAccount.get(e);
        // Prefer a healthy account if one email maps to several.
        if (!existing || (!existing.healthy && health.healthy)) {
          emailToAccount.set(e, { id, healthy: health.healthy, status: health.status });
        }
      }
    }

    const { data: rows, error } = await supabase
      .from("integration_accounts")
      .select("id, email_address, unipile_account_id_v2, is_active")
      .eq("account_type", "email");
    if (error) {
      logger.error("reconcile-unipile-accounts: db read failed", { error: error.message });
      return { error: error.message };
    }

    let ok = 0;
    let healed = 0;
    let unhealthy = 0;
    let disconnected = 0;

    for (const row of rows ?? []) {
      const email = normalizeEmail(row.email_address || "");
      const stored: string | null = row.unipile_account_id_v2;

      // Stored id still exists on Unipile → only worry about health.
      if (stored && liveIds.has(stored)) {
        const h = healthById.get(stored) ?? { healthy: true, status: "unknown" };
        if (!h.healthy) {
          unhealthy++;
          await notifyError({
            taskId: "reconcile-unipile-accounts",
            severity: "WARN",
            error: new Error(
              `Mailbox ${row.email_address} is unhealthy on Unipile (status: ${h.status}). Reconnect it in the Unipile dashboard.`,
            ),
            context: { email: row.email_address, unipile_account_id: stored, status: h.status },
          });
        } else {
          ok++;
        }
        continue;
      }

      // Stored id is gone → drift. Heal by matching the live account on email.
      const match = email ? emailToAccount.get(email) : undefined;
      if (match) {
        const { error: upErr } = await supabase
          .from("integration_accounts")
          .update({ unipile_account_id_v2: match.id, is_active: true, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (upErr) {
          logger.error("reconcile-unipile-accounts: heal update failed", {
            email: row.email_address,
            error: upErr.message,
          });
          continue;
        }
        healed++;
        logger.info("reconcile-unipile-accounts: auto-healed mailbox id", {
          email: row.email_address,
          from: stored,
          to: match.id,
        });
        await notifyError({
          taskId: "reconcile-unipile-accounts",
          severity: "WARN",
          error: new Error(
            `Auto-healed mailbox ${row.email_address}: Unipile id ${stored ?? "(none)"} → ${match.id} (it had been re-linked). Email flow restored without a deploy.`,
          ),
          context: { email: row.email_address, from: stored, to: match.id, status: match.status },
        });
      } else {
        disconnected++;
        await notifyError({
          taskId: "reconcile-unipile-accounts",
          severity: "ERROR",
          error: new Error(
            `Mailbox ${row.email_address} has no live Unipile account (stored id ${stored ?? "(none)"} is gone). Reconnect it in the Unipile dashboard to restore email.`,
          ),
          context: { email: row.email_address, stored_unipile_account_id: stored },
        });
      }
    }

    const summary = { liveAccounts: live.length, checked: (rows ?? []).length, ok, healed, unhealthy, disconnected };
    logger.info("reconcile-unipile-accounts complete", summary);
    return summary;
  },
);
