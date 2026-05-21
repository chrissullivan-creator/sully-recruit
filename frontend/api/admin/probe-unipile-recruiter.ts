import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { loadUnipileConfig } from "../lib/unipile-linkedin.js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/probe-unipile-recruiter
 *
 * Diagnostic only. Pings every URL combination we think Unipile might
 * use for the LinkedIn Recruiter hiring-projects endpoint and reports
 * back exactly which one returns 200 for a given account_id. Use this
 * to figure out the correct URL pattern when an account_id format
 * changes (Unipile rolled out a non-acc_xxx ID shape recently).
 *
 * Body: { account_ids: string[] }
 * Auth: Supabase JWT (any signed-in user).
 *
 * Returns:
 *   {
 *     account_id: string,
 *     attempts: Array<{ url, status, ok, response_snippet }>
 *   }[]
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

  const v1Host = config.v1Base.replace(/\/api\/v1\/?$/, "");
  const candidates = (acct: string) => [
    // v2 global, account in URL
    { name: "v2-global-path",   url: `${config.v2Base}/${encodeURIComponent(acct)}/linkedin/recruiter/projects?limit=1` },
    // v2 global, account as query
    { name: "v2-global-query",  url: `${config.v2Base}/linkedin/recruiter/projects?account_id=${encodeURIComponent(acct)}&limit=1` },
    // v2 on DSN, account in URL
    { name: "v2-dsn-path",      url: `${v1Host}/api/v2/${encodeURIComponent(acct)}/linkedin/recruiter/projects?limit=1` },
    // v2 on DSN, account as query
    { name: "v2-dsn-query",     url: `${v1Host}/api/v2/linkedin/recruiter/projects?account_id=${encodeURIComponent(acct)}&limit=1` },
    // v1 on DSN (per official docs), account as query
    { name: "v1-dsn-projects",  url: `${v1Host}/api/v1/linkedin/projects?account_id=${encodeURIComponent(acct)}&limit=1` },
    { name: "v1-dsn-hiring",    url: `${v1Host}/api/v1/linkedin/hiring/projects?account_id=${encodeURIComponent(acct)}&limit=1` },
    { name: "v1-dsn-recruiter", url: `${v1Host}/api/v1/linkedin/recruiter/projects?account_id=${encodeURIComponent(acct)}&limit=1` },
    // Account fetch — if THIS 404s, the account ID itself is dead
    { name: "v1-account-get",   url: `${v1Host}/api/v1/accounts/${encodeURIComponent(acct)}` },
  ];

  const results: any[] = [];
  for (const acct of accountIds) {
    const attempts: any[] = [];
    for (const c of candidates(acct)) {
      try {
        const resp = await fetch(c.url, {
          headers: { Accept: "application/json", "X-API-KEY": config.apiKey },
        });
        const text = await resp.text();
        attempts.push({
          name: c.name,
          url: c.url,
          status: resp.status,
          ok: resp.ok,
          response_snippet: text.slice(0, 240),
        });
      } catch (err: any) {
        attempts.push({
          name: c.name,
          url: c.url,
          status: 0,
          ok: false,
          response_snippet: `fetch-error: ${err.message || err}`,
        });
      }
    }
    results.push({ account_id: acct, attempts });
  }

  return res.status(200).json({ results });
}
