/**
 * POST /api/connect-linkedin
 *
 * Creates a Unipile Hosted-Auth link with Recruiter explicitly enabled,
 * so the resulting integration_accounts row gets `recruiter_inmail`
 * (and the Hiring Projects scope) instead of falling back to
 * `sales_nav_inmail` / `classic_message`.
 *
 * Body: {
 *   account_id?: string,            // pass to reconnect an existing row
 *   integration_account_id?: string,
 *   owner_user_id?: string,
 *   account_label?: string,
 *   contract_name?: string,
 * }
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
import {
  encodeLinkedinConnectState,
  loadUnipileConfig,
} from "./lib/unipile-linkedin.js";

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

  const {
    account_id,
    account_label,
    contract_name,
    integration_account_id,
    owner_user_id,
  } = (req.body || {}) as {
    account_id?: string;
    account_label?: string;
    contract_name?: string;
    integration_account_id?: string;
    owner_user_id?: string;
  };

  const config = await loadUnipileConfig(supabase);
  const origin = (req.headers.origin as string) || `https://${req.headers.host}` || "https://sullyrecruit.app";

  // The frontend may pass the v1 short-form account_id. v2 needs acc_xxx.
  if (account_id && !account_id.startsWith("acc_")) {
    const { data: row } = await supabase
      .from("integration_accounts")
      .select("metadata")
      .eq("unipile_account_id", account_id)
      .maybeSingle();
    const v2Id = row?.metadata?.unipile_account_id_v2;
    if (v2Id) account_id = v2Id;
  }

  // 10-minute expiry per Unipile's hosted-auth example.
  const expires_on = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const connectState = encodeLinkedinConnectState({
    accountLabel: account_label || null,
    contractName: contract_name || null,
    integrationAccountId: integration_account_id || null,
    ownerUserId: owner_user_id || user.id,
    reconnectAccountId: account_id || null,
    requestedByUserId: user.id,
  });
  const notifyUrl = new URL(`${origin}/api/connect-linkedin-notify`);
  notifyUrl.searchParams.set("state", connectState);
  notifyUrl.searchParams.set("token", config.notifyToken);

  const body: Record<string, any> = {
    // "reconnect" preserves the existing account_id when the user
    // re-authenticates; "create" provisions a new account.
    type: account_id ? "reconnect" : "create",
    providers: "LINKEDIN",
    expires_on,
    success_redirect_url: `${origin}/settings?linkedin_connected=1`,
    failure_redirect_url: `${origin}/settings?linkedin_error=1`,
    notify_url: notifyUrl.toString(),
    name: owner_user_id || user.id,
    config: {
      linkedin: {
        allow_methods: ["credentials", "cookies"],
        products: ["classic", "recruiter"],
      },
    },
  };
  if (account_id) body.reconnect_account = account_id;
  if (contract_name) {
    body.config.linkedin.contract_name = contract_name;
  }

  // v2 auth/link — uses the v2 API key + v2 base URL.
  const resp = await fetch(`${config.v2Base}/auth/link`, {
    method: "POST",
    headers: {
      "X-API-KEY": config.apiKeyV2,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[connect-linkedin] Unipile ${resp.status} :: ${text.slice(0, 500)}`);
    // Persist for post-hoc debug via Supabase MCP (Vercel log preview truncates).
    await supabase.from("app_settings").upsert(
      { key: "DEBUG_CONNECT_LINKEDIN_LAST", value: JSON.stringify({ status: resp.status, body: text.slice(0, 2000), sent: body, at: new Date().toISOString() }) },
      { onConflict: "key" },
    );
    return res.status(resp.status).json({
      error: `Unipile ${resp.status}: ${text.slice(0, 400)}`,
      body: text.slice(0, 500),
    });
  }
  const parsed = JSON.parse(text);
  return res.status(200).json({ url: parsed.url });
}
