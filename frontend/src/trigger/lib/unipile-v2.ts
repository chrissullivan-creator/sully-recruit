/**
 * Central Unipile v2 client. Every server-side caller routes through
 * here so the URL shape (account_id-in-path) and key resolution are
 * defined in one place.
 *
 * Key v2 facts (from
 *   https://developer.unipile.com/v2.0/docs/migration-linkedin-api ):
 *   - account_id is now a path segment, not a query/body param.
 *   - Each LinkedIn product has its own prefix:
 *       Classic:        /api/v2/{account_id}/linkedin/...
 *       Recruiter:      /api/v2/{account_id}/linkedin/recruiter/...
 *       Sales Navigator /api/v2/{account_id}/linkedin/sales-navigator/...
 *
 * Auth: Bearer UNIPILE_API_KEY_V2 (falls back to UNIPILE_API_KEY).
 */
import { logger } from "@trigger.dev/sdk/v3";

interface ResolvedConfig {
  base: string;
  apiKey: string;
}

let _cachedConfig: { value: ResolvedConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

async function resolveConfig(supabase: any): Promise<ResolvedConfig> {
  const now = Date.now();
  if (_cachedConfig && now - _cachedConfig.fetchedAt < CONFIG_TTL_MS) {
    return _cachedConfig.value;
  }
  const [{ data: v2Row }, { data: v1Row }, { data: v2KeyRow }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const base = (v2Row?.value || "").replace(/\/+$/, "")
    || (v1Row?.value || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "/api/v2");
  const apiKey = v2KeyRow?.value || v1KeyRow?.value;
  if (!base || !apiKey) throw new Error("Unipile v2 config missing");
  const value = { base, apiKey };
  _cachedConfig = { value, fetchedAt: now };
  return value;
}

/** Build a v2 URL with account_id in the path. `path` should not start
 *  with a slash AND should not include the leading account segment. */
export function unipileV2Path(base: string, accountId: string, path: string) {
  const clean = path.replace(/^\/+/, "");
  return `${base}/${encodeURIComponent(accountId)}/${clean}`;
}

export interface UnipileFetchInit extends Omit<RequestInit, "headers"> {
  query?: Record<string, string | number | undefined>;
  /** Extra headers merged on top of auth/Accept defaults. */
  headers?: Record<string, string>;
}

/**
 * Fetch any Unipile v2 endpoint scoped to a single account_id.
 * Throws on non-2xx with the response body in the message.
 *
 * Example:
 *   await unipileFetch(supabase, accountId, "linkedin/users/jane-doe", { method: "GET" })
 *   →  GET /api/v2/{account_id}/linkedin/users/jane-doe
 */
export async function unipileFetch<T = any>(
  supabase: any,
  accountId: string,
  path: string,
  init: UnipileFetchInit = {},
): Promise<T> {
  if (!accountId) throw new Error("unipileFetch: accountId required");
  const { base, apiKey } = await resolveConfig(supabase);
  const url = new URL(unipileV2Path(base, accountId, path));
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "X-API-KEY": apiKey,
    Accept: "application/json",
    ...(init.headers || {}),
  };
  // Set JSON Content-Type only when body is a string AND no content-type set.
  if (typeof init.body === "string" && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url.toString(), { ...init, headers });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Unipile ${resp.status} ${path}: ${text.slice(0, 300)}`);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/**
 * Look up the Unipile account_id for a given Sully user + provider.
 * provider is the Unipile-side label: "LINKEDIN" / "OUTLOOK" / etc.
 *
 * Falls back to any account for that user when the provider-specific
 * row isn't yet labelled. Returns null when nothing matches.
 */
export async function getUnipileAccountIdForUser(
  supabase: any,
  ownerUserId: string,
  provider: "LINKEDIN" | "OUTLOOK" | "GMAIL" | string,
): Promise<string | null> {
  const desiredProviderColumnGuess =
    provider === "LINKEDIN" ? "linkedin"
    : provider === "OUTLOOK" || provider === "GMAIL" ? "email"
    : null;

  // 1) Match by integration_accounts.unipile_provider exactly.
  const { data: byProvider } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id")
    .eq("owner_user_id", ownerUserId)
    .eq("unipile_provider", provider)
    .not("unipile_account_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (byProvider?.unipile_account_id) return byProvider.unipile_account_id;

  // 2) Fall back to the matching provider column (e.g. provider='linkedin').
  if (desiredProviderColumnGuess) {
    const { data: byColumn } = await supabase
      .from("integration_accounts")
      .select("unipile_account_id")
      .eq("owner_user_id", ownerUserId)
      .eq("provider", desiredProviderColumnGuess)
      .not("unipile_account_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (byColumn?.unipile_account_id) return byColumn.unipile_account_id;
  }

  return null;
}

/** Same lookup, but find any user's account that owns this email
 *  (used by send-email path where we know the from_email but not the
 *  user_id). */
export async function getUnipileAccountIdForEmail(
  supabase: any,
  emailAddress: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id")
    .eq("email_address", emailAddress.toLowerCase())
    .not("unipile_account_id", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.unipile_account_id ?? null;
}

/**
 * Map a sequence step's action.channel (or webhook-derived channel
 * label) to the canonical bucket we use in messages.channel. Three
 * LinkedIn-side buckets the UI cares about:
 *
 *   email                                   → email
 *   sms                                     → sms
 *   regular LinkedIn DMs (Classic/Sales Nav) → linkedin
 *   Recruiter InMail                         → linkedin_recruiter
 *
 * Sales Navigator messages collapse into `linkedin` so the inbox
 * stays a 3-way split — Recruiter InMail is the only channel users
 * route differently in practice.
 */
export function canonicalChannel(channel: string | null | undefined): string {
  const c = String(channel || "").toLowerCase();
  if (c === "email" || c === "sms") return c;
  if (c === "linkedin_inmail" || c === "linkedin_recruiter" || c === "recruiter_inmail") return "linkedin_recruiter";
  if (
    c === "linkedin" ||
    c === "linkedin_message" ||
    c === "linkedin_connection" ||
    c === "linkedin_classic" ||
    c === "linkedin_sales_nav" ||
    c === "sales_navigator"
  ) return "linkedin";
  // Pass-through for anything we don't recognise; logs surface it.
  return c || "unknown";
}

void logger; // tree-shake guard for the import
