import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { loadUnipileConfig } from "../lib/unipile-linkedin.js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/probe-unipile-recruiter
 *
 * Diagnostic only. Pings every LinkedIn / Recruiter endpoint we
 * currently rely on against the supplied account_id(s) and reports
 * back whether each one responds 200. Useful for verifying a freshly
 * connected account or diagnosing why a recruiter's sends are
 * dropping.
 *
 * The candidate URLs below are the *currently working* set: every
 * LinkedIn / Recruiter / messaging endpoint lives on the tenant DSN
 * at /api/v1, and account_id is a query parameter (not a path
 * segment). The historical v2-on-public-host shapes
 * (/v2/{acct}/linkedin/recruiter/...) are intentionally NOT probed
 * here — they return 403 Insufficient permissions on our app and
 * burn quota. If you need to re-verify whether v2 is enabled, run
 * an ad-hoc curl with UNIPILE_API_KEY_V2; don't add it back to
 * this probe.
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

  const v1 = config.v1Base.replace(/\/+$/, "");
  const candidates = (acct: string) => {
    const a = encodeURIComponent(acct);
    return [
      // Meta: account is alive
      { name: "v1-account-get",      url: `${v1}/accounts/${a}` },
      // LinkedIn Recruiter contracts
      { name: "v1-contracts",        url: `${v1}/linkedin/contracts?account_id=${a}` },
      // Hiring projects (project list + first project detail can't be
      // probed here without a project id, so just list)
      { name: "v1-projects",         url: `${v1}/linkedin/projects?account_id=${a}&limit=1` },
      // LinkedIn job postings (Talent Hub)
      { name: "v1-jobs",             url: `${v1}/linkedin/jobs?account_id=${a}&limit=1` },
      // InMail credits remaining
      { name: "v1-inmail-credits",   url: `${v1}/linkedin/inmail-credits?account_id=${a}` },
      // Inbound invitations
      { name: "v1-invite-received",  url: `${v1}/users/invite/received?account_id=${a}&limit=1` },
    ];
  };

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
