import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { loadUnipileConfig } from "../lib/unipile-linkedin.js";
import { getUnipileAccountV2IdByV1Id } from "../../src/server-lib/unipile-v2.js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/probe-unipile-recruiter
 *
 * Diagnostic only. Pings the LinkedIn / Recruiter endpoints we rely on for
 * each supplied account_id and reports the HTTP status of each, on BOTH:
 *
 *   - v1 (tenant DSN, /api/v1, account_id as a query param, UNIPILE_API_KEY)
 *   - v2 (api.unipile.com/v2, account_id as a PATH segment, UNIPILE_API_KEY_V2)
 *
 * The v2 section is the authoritative gate for the LinkedIn-Recruiter-on-v2
 * migration: it answers "does our app's v2 key have Recruiter scope, and
 * what are the real paths?" Read the status codes:
 *   200 → works  ·  403 → scope still gated (open a Unipile ticket)
 *   404 → wrong path  ·  401 → wrong key/host
 *
 * It also probes GET {v2Base}/accounts so you can read each account's
 * canonical acc_xxx id (needed to populate integration_accounts
 * .unipile_account_id_v2 before flipping UNIPILE_LINKEDIN_V2 on).
 *
 * Body: { account_ids: string[] }   // short-form v1 ids
 * Auth: Supabase JWT (any signed-in user).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const accountIds: string[] = Array.isArray(req.body?.account_ids) ? req.body.account_ids : [];
  if (accountIds.length === 0) {
    return res.status(400).json({ error: "account_ids (string[]) required" });
  }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const config = await loadUnipileConfig(supabase);

  const v1 = config.v1Base.replace(/\/+$/, "");
  const v2 = config.v2Base.replace(/\/+$/, "");
  const v1Headers = { Accept: "application/json", "X-API-KEY": config.apiKey };
  const v2Headers = { Accept: "application/json", "X-API-KEY": config.apiKeyV2 };

  async function probe(name: string, url: string, headers: Record<string, string>) {
    try {
      const resp = await fetch(url, { headers });
      const text = await resp.text();
      return { name, url, status: resp.status, ok: resp.ok, response_snippet: text.slice(0, 240) };
    } catch (err: any) {
      return { name, url, status: 0, ok: false, response_snippet: `fetch-error: ${err?.message || err}` };
    }
  }

  const v1Candidates = (acct: string) => {
    const a = encodeURIComponent(acct);
    return [
      { name: "v1-account-get", url: `${v1}/accounts/${a}` },
      { name: "v1-contracts", url: `${v1}/linkedin/contracts?account_id=${a}` },
      { name: "v1-projects", url: `${v1}/linkedin/projects?account_id=${a}&limit=1` },
      { name: "v1-jobs", url: `${v1}/linkedin/jobs?account_id=${a}&limit=1` },
      { name: "v1-inmail-credits", url: `${v1}/linkedin/inmail-credits?account_id=${a}` },
      { name: "v1-invite-received", url: `${v1}/users/invite/received?account_id=${a}&limit=1` },
    ];
  };

  // v2 GETs. Some of these are POST in real use (e.g. recruiter search);
  // a GET probe still distinguishes 403 (scope gated) / 404 (wrong path) /
  // 405 (path exists, wrong method) / 200, which is all we need to confirm
  // scope + path shape before wiring writes.
  const v2Candidates = (accV2: string) => {
    const a = encodeURIComponent(accV2);
    return [
      { name: "v2-recruiter-projects", url: `${v2}/${a}/linkedin/recruiter/projects?limit=1` },
      { name: "v2-recruiter-inmail-credits", url: `${v2}/${a}/linkedin/recruiter/inmail-credits` },
      { name: "v2-recruiter-search-people", url: `${v2}/${a}/linkedin/recruiter/search/people?limit=1` },
      { name: "v2-jobs", url: `${v2}/${a}/linkedin/jobs?limit=1` },
    ];
  };

  // Global v2 probe: lists connected v2 accounts (surfaces each acc_xxx id).
  const v2AccountsProbe = await probe("v2-accounts", `${v2}/accounts`, v2Headers);

  const results: any[] = [];
  for (const acct of accountIds) {
    const v1Attempts = [];
    for (const c of v1Candidates(acct)) v1Attempts.push(await probe(c.name, c.url, v1Headers));

    const acctV2 = await getUnipileAccountV2IdByV1Id(supabase, acct);
    const v2Attempts = [];
    if (acctV2) {
      for (const c of v2Candidates(acctV2)) v2Attempts.push(await probe(c.name, c.url, v2Headers));
    }

    results.push({
      account_id: acct,
      acc_v2_id: acctV2,
      v2_note: acctV2
        ? undefined
        : "No unipile_account_id_v2 stored yet — read v2_accounts below for this account's acc_xxx, then backfill the column.",
      v1_attempts: v1Attempts,
      v2_attempts: v2Attempts,
    });
  }

  return res.status(200).json({ v2_accounts: v2AccountsProbe, results });
}
