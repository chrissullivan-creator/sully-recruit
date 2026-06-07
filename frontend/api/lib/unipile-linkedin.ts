import crypto from "node:crypto";

interface UnipileConfig {
  apiKey: string;
  apiKeyV2: string;
  notifyToken: string;
  v1Base: string;
  v2Base: string;
}

export interface LinkedinConnectState {
  accountLabel?: string | null;
  contractName?: string | null;
  integrationAccountId?: string | null;
  ownerUserId: string;
  reconnectAccountId?: string | null;
  requestedByUserId: string;
}

interface SyncLinkedinAccountParams {
  accountLabel?: string | null;
  authMethod: "hosted" | "cookies";
  contractName?: string | null;
  integrationAccountId?: string | null;
  ownerUserId: string;
  proxyCountry?: string | null;
  requestedByUserId: string;
  unipileAccountId: string;
  userAgent?: string | null;
}

interface ContractMatch {
  id: string;
  name: string;
}

interface RecruiterAccessCheck {
  detail?: string | null;
  enabled: boolean;
  status: number;
}

const INACTIVE_ACCOUNT_STATUSES = new Set([
  "CREDENTIALS",
  "DELETED",
  "ERROR",
  "STOPPED",
]);

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

function normalizeCountry(value: string | null | undefined): string | null {
  const country = String(value || "").trim().toUpperCase();
  return country || null;
}

function parseJsonIfPossible(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function flattenStringValues(value: any, bucket: string[] = []): string[] {
  if (value == null) return bucket;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) bucket.push(trimmed);
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStringValues(item, bucket);
    return bucket;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) flattenStringValues(nested, bucket);
  }
  return bucket;
}

function detectSalesNavigator(account: any): boolean {
  const haystack = flattenStringValues(account).join(" ").toLowerCase();
  return haystack.includes("sales_navigator")
    || haystack.includes("sales navigator")
    || haystack.includes("salesnav");
}

function detectAccountStatus(account: any): string | null {
  return firstString(
    account?.source_status,
    account?.status,
    account?.connection_status,
    account?.sync_status,
    account?.message,
  );
}

function buildCapabilities(recruiterEnabled: boolean, salesNavigatorEnabled: boolean): string[] {
  if (recruiterEnabled) {
    return ["recruiter_inmail", "classic_message", "connection_request"];
  }
  if (salesNavigatorEnabled) {
    return ["sales_nav_inmail", "classic_message", "connection_request"];
  }
  return ["classic_message", "connection_request"];
}

function extractAccountLabel(account: any, fallback: string): string {
  return firstString(
    account?.name,
    account?.label,
    account?.account_name,
    account?.display_name,
    account?.profile?.full_name,
    account?.profile?.display_name,
    account?.account_info?.full_name,
    fallback,
  ) || fallback;
}

function extractAccountEmail(account: any, fallback: string | null): string | null {
  return normalizeEmail(firstString(
    account?.email,
    account?.mail,
    account?.account_info?.email,
    account?.profile?.email,
    account?.profile?.mail,
    account?.credentials?.username,
    fallback,
  ));
}

function createNotifyToken(seed: string): string {
  return crypto
    .createHash("sha256")
    .update(`sully-recruit:unipile-linkedin-notify:${seed}`)
    .digest("hex");
}

export function encodeLinkedinConnectState(state: LinkedinConnectState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeLinkedinConnectState(value: string | null | undefined): LinkedinConnectState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.ownerUserId || !parsed.requestedByUserId) {
      return null;
    }
    return parsed as LinkedinConnectState;
  } catch {
    return null;
  }
}

export function extractHostedAuthCallback(payload: any): {
  accountId: string | null;
  name: string | null;
  status: string | null;
} {
  const body = payload || {};
  return {
    accountId: firstString(
      body.account_id,
      body.accountId,
      body.id,
      body.data?.account_id,
      body.AccountStatus?.account_id,
    ),
    name: firstString(body.name, body.data?.name),
    status: firstString(
      body.status,
      body.message,
      body.AccountStatus?.message,
      body.data?.status,
    ),
  };
}

export async function loadUnipileConfig(supabase: any): Promise<UnipileConfig> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "UNIPILE_API_KEY",
      "UNIPILE_API_KEY_V2",
      "UNIPILE_BASE_URL",
      "UNIPILE_BASE_V2_URL",
      "UNIPILE_LINKEDIN_NOTIFY_TOKEN",
      "UNIPILE_WEBHOOK_SECRET",
    ]);

  if (error) throw new Error(`Failed to load Unipile config: ${error.message}`);

  const rows = new Map<string, string>();
  for (const row of data ?? []) {
    rows.set(row.key, String(row.value ?? ""));
  }

  const v1Base = (rows.get("UNIPILE_BASE_URL") || "https://api19.unipile.com:14926/api/v1").replace(/\/+$/, "");
  const v2Base = (rows.get("UNIPILE_BASE_V2_URL") || "https://api.unipile.com/v2").replace(/\/+$/, "");
  const apiKey = rows.get("UNIPILE_API_KEY") || rows.get("UNIPILE_API_KEY_V2") || "";
  const apiKeyV2 = rows.get("UNIPILE_API_KEY_V2") || apiKey;
  if (!apiKey) throw new Error("UNIPILE_API_KEY missing");

  const notifySeed =
    process.env.UNIPILE_LINKEDIN_NOTIFY_TOKEN
    || process.env.UNIPILE_WEBHOOK_SECRET
    || rows.get("UNIPILE_LINKEDIN_NOTIFY_TOKEN")
    || rows.get("UNIPILE_WEBHOOK_SECRET")
    || apiKey;

  return {
    apiKey,
    apiKeyV2,
    notifyToken: createNotifyToken(notifySeed),
    v1Base,
    v2Base,
  };
}

async function parseUnipileResponse(resp: Response): Promise<{ data: any; text: string }> {
  const text = await resp.text();
  return {
    data: parseJsonIfPossible(text),
    text,
  };
}

async function fetchUnipileV1(
  config: UnipileConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ data: any; status: number }> {
  const resp = await fetch(`${config.v1Base}${path.startsWith("/") ? "" : "/"}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-API-KEY": config.apiKey,
      ...(init.headers || {}),
    },
  });

  const { data, text } = await parseUnipileResponse(resp);
  if (!resp.ok) {
    throw new Error(`Unipile ${resp.status}: ${String(text).slice(0, 400)}`);
  }
  return { data, status: resp.status };
}

export async function fetchUnipileAccount(config: UnipileConfig, accountId: string): Promise<any> {
  const { data } = await fetchUnipileV1(config, `/accounts/${encodeURIComponent(accountId)}`);
  return data;
}

export async function verifyRecruiterProjectsAccess(
  config: UnipileConfig,
  accountId: string,
): Promise<RecruiterAccessCheck> {
  // Per Unipile docs and direct probe: Recruiter hiring projects live
  // at /api/v1/linkedin/projects?account_id=... on the tenant DSN.
  // The older /v2/{acct}/linkedin/recruiter/projects pattern we used
  // hits api.unipile.com/v2 which returns "Route Not Found" (not a real
  // host) — and even when we tried it on the DSN, /api/v2 doesn't
  // exist either. The 401 'Invalid API Key' was Unipile's confusing
  // way of saying the route was wrong.
  const url = new URL(`${config.v1Base}/linkedin/projects`);
  url.searchParams.set("account_id", accountId);
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-API-KEY": config.apiKey,
    },
  });
  const { text } = await parseUnipileResponse(resp);

  if (resp.ok) return { enabled: true, status: resp.status };
  if ([401, 403, 404].includes(resp.status)) {
    return {
      enabled: false,
      status: resp.status,
      detail: text.slice(0, 400),
    };
  }

  throw new Error(`Recruiter verification failed (${resp.status}): ${text.slice(0, 300)}`);
}

export async function applyUnipileProxyCountry(
  _config: UnipileConfig,
  accountId: string,
  country: string,
): Promise<void> {
  // Proxy-country override is a Unipile v2 feature
  // (PATCH /v2/{account_id}/proxy). v1 has no equivalent — proxy
  // configuration is a tenant-level concept on v1. Our v2 app key
  // returns 403 Insufficient permissions on /proxy, so this call
  // can't succeed either way. Skipping is fine: existing accounts
  // already have a proxy attached at tenant-creation time.
  void accountId;
  void country;
  // 501 — caller can surface this as a warning without failing the
  // connect flow.
  throw new Error(
    "Unipile proxy-country override is not available — v2 endpoint "
    + "is 403 for our app, v1 has no equivalent. Proxy is set at "
    + "tenant level instead.",
  );
}

export async function listLinkedinContracts(
  config: UnipileConfig,
  accountId: string,
): Promise<ContractMatch[]> {
  const { data } = await fetchUnipileV1(
    config,
    `/linkedin/contracts?account_id=${encodeURIComponent(accountId)}`,
  );

  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.contracts)
          ? data.contracts
          : [];

  return items
    .map((item: any) => ({
      id: firstString(item?.id, item?.contract_id) || "",
      name: firstString(item?.name, item?.label, item?.company_name, item?.title) || "",
    }))
    .filter((item: ContractMatch) => item.id && item.name);
}

export async function selectLinkedinContractByName(
  config: UnipileConfig,
  accountId: string,
  desiredName: string,
): Promise<ContractMatch | null> {
  const target = desiredName.trim().toLowerCase();
  if (!target) return null;

  const contracts = await listLinkedinContracts(config, accountId);
  const match = contracts.find((item) => item.name.toLowerCase() === target)
    || contracts.find((item) => item.name.toLowerCase().includes(target))
    || contracts.find((item) => target.includes(item.name.toLowerCase()));
  if (!match) return null;

  const path = `/linkedin/contracts/${encodeURIComponent(match.id)}/select?account_id=${encodeURIComponent(accountId)}`;
  try {
    await fetchUnipileV1(config, path, { method: "POST" });
    return match;
  } catch {
    await fetchUnipileV1(
      config,
      `/linkedin/contracts/${encodeURIComponent(match.id)}/select`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      },
    );
    return match;
  }
}

export async function updateLinkedinAccountStatus(
  supabase: any,
  accountId: string,
  status: string | null | undefined,
  extraMetadata: Record<string, any> = {},
): Promise<void> {
  if (!accountId || !status) return;

  const { data: existing } = await supabase
    .from("integration_accounts")
    .select("id, metadata")
    .eq("unipile_account_id", accountId)
    .maybeSingle();

  if (!existing?.id) return;

  const normalizedStatus = status.trim().toUpperCase();
  const metadata = {
    ...(existing.metadata || {}),
    ...extraMetadata,
    unipile_status: normalizedStatus,
    unipile_status_updated_at: new Date().toISOString(),
  };

  await supabase
    .from("integration_accounts")
    .update({
      is_active: !INACTIVE_ACCOUNT_STATUSES.has(normalizedStatus),
      metadata,
      updated_at: new Date().toISOString(),
    } as any)
    .eq("id", existing.id);
}

export async function syncLinkedinIntegrationAccount(
  supabase: any,
  params: SyncLinkedinAccountParams,
): Promise<{
  account: any;
  capabilities: string[];
  contract: ContractMatch | null;
  integrationAccount: any;
  recruiterEnabled: boolean;
  warnings: string[];
}> {
  const config = await loadUnipileConfig(supabase);
  const warnings: string[] = [];

  const { data: ownerProfile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", params.ownerUserId)
    .maybeSingle();

  let account: any = null;
  try {
    account = await fetchUnipileAccount(config, params.unipileAccountId);
  } catch (err: any) {
    warnings.push(`Account detail lookup failed: ${err.message}`);
  }

  const proxyCountry = normalizeCountry(params.proxyCountry);
  if (proxyCountry) {
    try {
      await applyUnipileProxyCountry(config, params.unipileAccountId, proxyCountry);
    } catch (err: any) {
      warnings.push(err.message);
    }
  }

  let selectedContract: ContractMatch | null = null;
  if (params.contractName?.trim()) {
    try {
      selectedContract = await selectLinkedinContractByName(
        config,
        params.unipileAccountId,
        params.contractName,
      );
      if (!selectedContract) {
        warnings.push(`Recruiter contract "${params.contractName}" was not found in Unipile.`);
      }
    } catch (err: any) {
      warnings.push(`Recruiter contract selection failed: ${err.message}`);
    }
  }

  let recruiterCheck: RecruiterAccessCheck = { enabled: false, status: 0 };
  try {
    recruiterCheck = await verifyRecruiterProjectsAccess(config, params.unipileAccountId);
  } catch (err: any) {
    warnings.push(err.message);
  }

  const recruiterEnabled = recruiterCheck.enabled || !!selectedContract;
  const salesNavigatorEnabled = !recruiterEnabled && detectSalesNavigator(account);
  const capabilities = buildCapabilities(recruiterEnabled, salesNavigatorEnabled);

  const ownerEmail = normalizeEmail(ownerProfile?.email);
  const ownerName = firstString(ownerProfile?.full_name, ownerEmail, params.ownerUserId) || params.ownerUserId;
  const accountLabel = extractAccountLabel(account, params.accountLabel || ownerName);
  const emailAddress = extractAccountEmail(account, ownerEmail);
  const accountStatus = (detectAccountStatus(account) || (recruiterEnabled ? "OK" : "CONNECTING"))?.toUpperCase();
  const linkedinCapability = recruiterEnabled
    ? "recruiter"
    : salesNavigatorEnabled
      ? "sales_navigator"
      : "classic";

  let existing: any = null;
  if (params.integrationAccountId) {
    const { data } = await supabase
      .from("integration_accounts")
      .select("*")
      .eq("id", params.integrationAccountId)
      .maybeSingle();
    existing = data ?? null;
  }

  if (!existing) {
    const { data } = await supabase
      .from("integration_accounts")
      .select("*")
      .eq("unipile_account_id", params.unipileAccountId)
      .maybeSingle();
    existing = data ?? null;
  }

  if (!existing && emailAddress) {
    const { data } = await supabase
      .from("integration_accounts")
      .select("*")
      .eq("provider", "linkedin")
      .eq("email_address", emailAddress)
      .maybeSingle();
    existing = data ?? null;
  }

  if (!existing) {
    const { data } = await supabase
      .from("integration_accounts")
      .select("*")
      .eq("provider", "linkedin")
      .eq("owner_user_id", params.ownerUserId)
      .limit(1)
      .maybeSingle();
    existing = data ?? null;
  }

  const now = new Date().toISOString();
  const metadata = {
    ...(existing?.metadata || {}),
    auth_method: params.authMethod,
    connected_at: now,
    recruiter_contract_id: selectedContract?.id ?? existing?.metadata?.recruiter_contract_id ?? null,
    recruiter_contract_name: selectedContract?.name ?? params.contractName ?? existing?.metadata?.recruiter_contract_name ?? null,
    recruiter_verified_at: recruiterEnabled ? now : existing?.metadata?.recruiter_verified_at ?? null,
    source: params.authMethod === "cookies" ? "unipile-cookie-auth" : "unipile-hosted-auth",
    unipile_recruiter_check: recruiterCheck.status || null,
    unipile_recruiter_detail: recruiterCheck.detail ?? null,
    unipile_status: accountStatus,
    unipile_status_updated_at: now,
    user_agent: params.userAgent || existing?.metadata?.user_agent || null,
    proxy_country: proxyCountry || existing?.metadata?.proxy_country || null,
  };

  // Opportunistically capture the canonical v2 id (acc_xxx) if any source
  // exposes it. The hosted-auth callback / account detail may carry it; if
  // not, it stays null until the GET {v2Base}/accounts backfill populates it.
  const unipileAccountIdV2 =
    [params.unipileAccountId, account?.id, account?.account_id, account?.unipile_account_id]
      .find((v: any) => typeof v === "string" && /^acc_/.test(v))
    || existing?.unipile_account_id_v2
    || null;

  const payload = {
    account_label: accountLabel,
    account_type: recruiterEnabled ? "linkedin_recruiter" : "linkedin_classic",
    auth_provider: "linkedin",
    email_address: emailAddress,
    is_active: !INACTIVE_ACCOUNT_STATUSES.has(accountStatus || ""),
    linkedin_capabilities: capabilities,
    linkedin_capability: linkedinCapability,
    metadata,
    owner_user_id: params.ownerUserId,
    provider: "linkedin",
    unipile_account_id: params.unipileAccountId,
    unipile_account_id_v2: unipileAccountIdV2,
    unipile_provider: "LINKEDIN",
    updated_at: now,
    user_id: params.ownerUserId,
  };

  let integrationAccount: any = null;
  if (existing?.id) {
    const { data, error } = await supabase
      .from("integration_accounts")
      .update(payload as any)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update integration account: ${error.message}`);
    integrationAccount = data;
  } else {
    const { data, error } = await supabase
      .from("integration_accounts")
      .insert(payload as any)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to insert integration account: ${error.message}`);
    integrationAccount = data;
  }

  return {
    account,
    capabilities,
    contract: selectedContract,
    integrationAccount,
    recruiterEnabled,
    warnings,
  };
}
