/**
 * POST /api/connect-linkedin
 *
 * Creates a Unipile Hosted-Auth link with Recruiter explicitly enabled,
 * so the resulting integration_accounts row gets `recruiter_inmail`
 * (and the Hiring Projects scope) instead of falling back to
 * `sales_nav_inmail` / `classic_message`.
 *
 * Body: { account_id?: string }  // pass to reconnect an existing row
 * Returns: { url: string }       // open this in a tab; Unipile redirects
 *                                 // back to /settings?linkedin_connected=1
 *
 * Required for the LinkedIn Recruiter Hiring Projects API per Unipile
 * docs: even an account holding a Recruiter seat returns
 * `api/insufficient_permissions` unless the `recruiter` product was
 * specified at link time.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Missing auth" });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) return res.status(401).json({ error: "Invalid auth" });
  const user = userData.user;

  const [{ data: v1Row }, { data: keyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  // Hosted-auth lives on the v1 DSN; the v2 host doesn't expose it.
  const v1Base = (v1Row?.value || "https://api19.unipile.com:14926/api/v1").replace(/\/+$/, "");
  const apiKey = keyRow?.value;
  if (!apiKey) return res.status(500).json({ error: "UNIPILE_API_KEY missing" });

  const { account_id } = (req.body || {}) as { account_id?: string };
  const origin = (req.headers.origin as string) || `https://${req.headers.host}` || "https://sullyrecruit.app";

  // 10-minute expiry per Unipile's hosted-auth example.
  const expires_on = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const body: Record<string, any> = {
    // "reconnect" preserves the existing account_id when the user
    // re-authenticates; "create" provisions a new account.
    type: account_id ? "reconnect" : "create",
    providers: "LINKEDIN",
    api_url: v1Base.replace(/\/api\/v1$/, ""),
    expires_on,
    success_redirect_url: `${origin}/settings?linkedin_connected=1`,
    failure_redirect_url: `${origin}/settings?linkedin_error=1`,
    // `name` becomes the account_label fallback in our integration_accounts
    // row when our webhook inserts it.
    name: user.email || user.id,
    linkedin: {
      // Cookies are docs-recommended for Recruiter — credentials sometimes
      // can't reach the Recruiter session even when the seat exists.
      allow_methods: ["credentials", "cookies"],
      products: ["classic", "recruiter"],
    },
  };
  if (account_id) body.reconnect_account = account_id;

  const resp = await fetch(`${v1Base}/hosted/accounts/link`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[connect-linkedin] Unipile ${resp.status} :: ${text.slice(0, 500)}`);
    return res.status(resp.status).json({
      error: `Unipile ${resp.status}`,
      body: text.slice(0, 500),
    });
  }
  const parsed = JSON.parse(text);
  return res.status(200).json({ url: parsed.url });
}
