import { fetchWithRetry } from "./fetch-retry.js";

export const RC_SERVER = "https://platform.ringcentral.com";

export interface RcCallLogResult {
  records: any[];
  /** Which endpoint produced the records, or null when both were rejected. */
  scope: "account" | "extension" | null;
  /** Set only when BOTH scopes returned 401/403 — i.e. genuine re-auth needed. */
  authError?: { status: number; body: string };
}

interface FetchOpts {
  dateFrom: string;
  dateTo?: string;
  perPage?: number;
  maxPages?: number;
  /** Friendly label for retry/log lines. */
  label?: string;
}

/**
 * Fetch the RingCentral Voice call log, preferring the **account-level**
 * endpoint (`/account/~/call-log`, which returns every extension's calls when
 * the JWT is account-admin) and falling back to the **per-extension** endpoint
 * (`/account/~/extension/~/call-log`) when the JWT isn't account-admin (a
 * 401/403 on the first page). Wrapped in `fetchWithRetry` so 429/5xx are
 * retried with backoff. Pages up to `maxPages`.
 *
 * Shared by `poll-rc-calls` (ingest) and `call-deepgram-runner` (recording
 * lookup) so the account-vs-extension choice can't drift out of sync — that
 * drift is exactly what left recordings un-found while calls ingested fine.
 *
 * Returns the records plus which `scope` produced them (callers attribute by
 * extension on account scope, or to the single seat on extension scope), and
 * an `authError` only when both scopes reject auth.
 */
export async function fetchRcCallLog(
  token: string,
  { dateFrom, dateTo, perPage = 100, maxPages = 30, label = "rc-call-log" }: FetchOpts,
): Promise<RcCallLogResult> {
  for (const scope of ["account", "extension"] as const) {
    const path =
      scope === "account"
        ? "/restapi/v1.0/account/~/call-log"
        : "/restapi/v1.0/account/~/extension/~/call-log";
    const records: any[] = [];
    let page = 1;
    let fellBack = false;

    while (page <= maxPages) {
      const params = new URLSearchParams({
        type: "Voice",
        view: "Detailed",
        dateFrom,
        perPage: String(perPage),
        page: String(page),
      });
      if (dateTo) params.set("dateTo", dateTo);

      const r = await fetchWithRetry(
        `${RC_SERVER}${path}?${params}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
        { label: `${label}:${scope}` },
      );

      if (!r.ok) {
        // First-page 401/403 means this JWT lacks this scope. Try the next one
        // (account → extension); if the per-extension scope is also rejected,
        // it's a genuine re-auth situation.
        if (page === 1 && (r.status === 401 || r.status === 403)) {
          if (scope === "account") {
            fellBack = true;
            break; // fall through to the extension scope
          }
          const body = (await r.text()).slice(0, 300);
          return { records: [], scope: null, authError: { status: r.status, body } };
        }
        // Any other error (or an error on a later page): return what we have.
        return { records, scope };
      }

      const d = await r.json();
      const recs = d.records ?? [];
      records.push(...recs);
      if (recs.length < perPage) return { records, scope };
      page++;
    }

    if (!fellBack) return { records, scope }; // completed (or hit maxPages) on this scope
    // else: account scope was rejected — continue to the extension scope
  }

  // Unreachable in practice (the extension branch always returns), but keeps
  // the control flow total.
  return { records: [], scope: null };
}
