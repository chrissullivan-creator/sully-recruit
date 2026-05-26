import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  extractHostedAuthCallback,
  loadUnipileConfig,
  syncLinkedinIntegrationAccount,
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
    li_a,
    li_at,
    owner_user_id,
    proxy_country,
    user_agent,
  } = (req.body || {}) as {
    account_id?: string;
    account_label?: string;
    contract_name?: string;
    integration_account_id?: string;
    li_a?: string;
    li_at?: string;
    owner_user_id?: string;
    proxy_country?: string;
    user_agent?: string;
  };

  if (!li_at?.trim()) {
    return res.status(400).json({ error: "Missing li_at cookie" });
  }
  if (!user_agent?.trim()) {
    return res.status(400).json({ error: "Missing user_agent" });
  }

  const config = await loadUnipileConfig(supabase);
  const targetAccountId = account_id?.trim() || null;
  const body: Record<string, any> = {
    provider: "LINKEDIN",
    access_token: li_at.trim(),
    config: {
      products: ["classic", "recruiter"],
    },
    user_agent: user_agent.trim(),
  };
  if (li_a?.trim()) body.premium_access_token = li_a.trim();
  if (proxy_country?.trim()) body.country = proxy_country.trim().toUpperCase();

  // v2: POST /v2/auth/intent (cookie auth flow)
  // If reconnecting an existing account, include the account_id in the body.
  if (targetAccountId) body.account_id = targetAccountId;
  const resp = await fetch(
    `${config.v2Base}/auth/intent`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": config.apiKeyV2,
      },
      body: JSON.stringify(body),
    },
  );

  const text = await resp.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (resp.status === 202) {
    const checkpoint = extractHostedAuthCallback(parsed);
    return res.status(202).json({
      account_id: checkpoint.accountId || targetAccountId,
      checkpoint: parsed?.checkpoint || null,
      requires_action: true,
      raw: parsed,
    });
  }
  if (!resp.ok) {
    console.error(`[connect-linkedin-cookies] Unipile ${resp.status} :: ${text.slice(0, 500)}`);
    await supabase.from("app_settings").upsert(
      {
        key: "DEBUG_CONNECT_LINKEDIN_COOKIES_LAST",
        value: JSON.stringify({
          at: new Date().toISOString(),
          sent: {
            ...body,
            access_token: "[redacted]",
            premium_access_token: body.premium_access_token ? "[redacted]" : undefined,
          },
          status: resp.status,
          body: text.slice(0, 2000),
        }),
      },
      { onConflict: "key" },
    );
    return res.status(resp.status).json({
      error: `Unipile ${resp.status}: ${text.slice(0, 400)}`,
    });
  }

  const connectedAccountId =
    parsed?.account_id
    || parsed?.id
    || parsed?.data?.account_id
    || targetAccountId;

  // Snapshot the success-path response so we can see what Unipile
  // actually returned when account_id ends up looking off (e.g. not
  // the expected acc_xxx shape).
  await supabase.from("app_settings").upsert(
    {
      key: "DEBUG_CONNECT_LINKEDIN_COOKIES_LAST",
      value: JSON.stringify({
        at: new Date().toISOString(),
        status: resp.status,
        ok: true,
        extracted_account_id: connectedAccountId,
        unipile_response_keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
        unipile_response: parsed,
      }).slice(0, 4000),
    },
    { onConflict: "key" },
  );

  if (!connectedAccountId) {
    return res.status(500).json({ error: "Unipile did not return an account_id" });
  }

  const sync = await syncLinkedinIntegrationAccount(supabase, {
    accountLabel: account_label || null,
    authMethod: "cookies",
    contractName: contract_name || null,
    integrationAccountId: integration_account_id || null,
    ownerUserId: owner_user_id || user.id,
    proxyCountry: proxy_country || null,
    requestedByUserId: user.id,
    unipileAccountId: connectedAccountId,
    userAgent: user_agent,
  });

  return res.status(200).json({
    account_id: connectedAccountId,
    connected: true,
    integration_account_id: sync.integrationAccount.id,
    recruiter_enabled: sync.recruiterEnabled,
    warnings: sync.warnings,
  });
}
