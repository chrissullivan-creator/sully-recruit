import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import {
  decodeLinkedinConnectState,
  extractHostedAuthCallback,
  loadUnipileConfig,
  syncLinkedinIntegrationAccount,
  updateLinkedinAccountStatus,
} from "./lib/unipile-linkedin.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const config = await loadUnipileConfig(supabase);
  const providedToken = typeof req.query.token === "string" ? req.query.token : "";
  if (!timingSafeEqual(providedToken, config.notifyToken)) {
    return res.status(401).json({ error: "Invalid notify token" });
  }

  const connectState = decodeLinkedinConnectState(
    typeof req.query.state === "string" ? req.query.state : "",
  );
  const callback = extractHostedAuthCallback(req.body || {});

  await supabase.from("app_settings").upsert(
    {
      key: "DEBUG_CONNECT_LINKEDIN_NOTIFY_LAST",
      value: JSON.stringify({
        at: new Date().toISOString(),
        payload: req.body,
        query: req.query,
      }).slice(0, 4000),
    },
    { onConflict: "key" },
  );

  if (!callback.accountId) {
    return res.status(400).json({ error: "Missing account_id" });
  }

  const ownerUserId = connectState?.ownerUserId || callback.name;
  const requestedByUserId = connectState?.requestedByUserId || ownerUserId;
  if (!ownerUserId || !requestedByUserId) {
    return res.status(400).json({ error: "Missing user mapping for LinkedIn account" });
  }

  const sync = await syncLinkedinIntegrationAccount(supabase, {
    accountLabel: connectState?.accountLabel || null,
    authMethod: "hosted",
    contractName: connectState?.contractName || null,
    integrationAccountId: connectState?.integrationAccountId || null,
    ownerUserId,
    requestedByUserId,
    unipileAccountId: callback.accountId,
  });

  await updateLinkedinAccountStatus(supabase, callback.accountId, callback.status, {
    last_hosted_auth_status: callback.status || null,
    last_hosted_auth_status_at: new Date().toISOString(),
  });

  return res.status(200).json({
    connected: true,
    integration_account_id: sync.integrationAccount.id,
    recruiter_enabled: sync.recruiterEnabled,
    warnings: sync.warnings,
  });
}
