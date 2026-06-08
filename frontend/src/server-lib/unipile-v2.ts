/**
 * Central Unipile client. Every server-side caller routes through here
 * so the URL shape and key resolution are defined in one place.
 *
 * Why this file is still named "unipile-v2.ts": it used to target
 * api.unipile.com/v2 (where account_id was a path segment). That host
 * exists for our tenant but our v2 app key returns 403 Insufficient
 * permissions on every LinkedIn/Recruiter/messaging call (Unipile-side
 * scope gate), AND v2 requires `acc_xxx`-format account IDs that we
 * don't store. Per Unipile's published v2 OpenAPI spec, the v2 host
 * only exposes 8 endpoints anyway: /accounts, /auth/*, /webhooks/*.
 * All LinkedIn / messaging / email endpoints live exclusively on
 * /api/v1 on the tenant DSN, take account_id as a query parameter,
 * and use the v1 API key.
 *
 * So we keep this module's NAME (too many imports to chase) but it now
 * routes to v1. The path translation rules are below in
 * `translatePathToV1`.
 *
 * Lifecycle endpoints (POST /v2/auth/link, POST /v2/auth/checkpoint,
 * POST /v2/accounts) are intentionally NOT routed through here. They
 * live in connect-linkedin*.ts and call api.unipile.com/v2 directly
 * with UNIPILE_API_KEY_V2 — that surface is the only part of v2 that
 * actually works for us.
 *
 * Auth: X-API-KEY = UNIPILE_API_KEY (v1 key).
 */
import { logger } from "./logger.js";

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
  const [{ data: v1Row }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  // The v1 DSN is the only Unipile host that serves LinkedIn /
  // messaging / email endpoints for our tenant. Default to the known
  // DSN value so callers without an explicit setting still work.
  const base = (v1Row?.value || "").replace(/\/+$/, "")
    || "https://api19.unipile.com:14926/api/v1";
  const apiKey = v1KeyRow?.value;
  if (!base || !apiKey) throw new Error("Unipile config missing (UNIPILE_BASE_URL or UNIPILE_API_KEY)");
  const value = { base, apiKey };
  _cachedConfig = { value, fetchedAt: now };
  return value;
}

/**
 * Translate a path that was written for the old v2 shape
 * (`linkedin/users/{slug}`, `chats`, `inboxes/{id}/chats/send` etc.)
 * into the equivalent v1 path. Every v1 LinkedIn / messaging route
 * takes account_id as a QUERY parameter, not a path segment, so the
 * account_id is added by `unipileFetch` separately.
 *
 * Returns null when the caller hit a v2-only shape with no v1
 * equivalent — caller should 501 or fall back gracefully.
 */
export function translatePathToV1(path: string): string | null {
  const clean = path.replace(/^\/+/, "");

  // ── LinkedIn user lookups ─────────────────────────────────────────
  // v2: linkedin/users/{slug}      → v1: users/{slug}
  // v2: linkedin/users/invite      → v1: users/invite
  if (clean.startsWith("linkedin/users/invitations/")) {
    // v2: linkedin/users/invitations/received → v1: users/invite/received
    // Probed: v1 exposes /api/v1/users/invite/received (or sent).
    const rest = clean.replace(/^linkedin\/users\/invitations\//, "");
    return `users/invite/${rest}`;
  }
  if (clean.startsWith("linkedin/users/invite")) {
    return clean.replace(/^linkedin\/users\/invite/, "users/invite");
  }
  if (clean.startsWith("linkedin/users/")) {
    return clean.replace(/^linkedin\/users\//, "users/");
  }
  if (clean.startsWith("users/invitations/")) {
    // legacy form some callers used (no `linkedin/` prefix)
    const rest = clean.replace(/^users\/invitations\//, "");
    return `users/invite/${rest}`;
  }

  // ── LinkedIn search ───────────────────────────────────────────────
  // v2: linkedin/recruiter/search/people → v1: linkedin/search (body
  //     selects api='recruiter')
  if (clean === "linkedin/recruiter/search/people"
    || clean.startsWith("linkedin/recruiter/search/people?")) {
    return "linkedin/search";
  }

  // ── Inbox-scoped recruiter send (v2-only — no v1 equivalent) ─────
  // v2: inboxes/{id}/chats/send → null (caller should fall back to /chats)
  if (clean.startsWith("inboxes/")) {
    // The /api/v1 surface has no inbox concept; v1 routes top-level
    // /chats and /messages with account_id as query. Return null so
    // the caller knows to use the legacy /chats path or 501 itself.
    return null;
  }

  // ── Recruiter InMail credits ──────────────────────────────────────
  // v2: linkedin/recruiter/inmail-credits → v1: linkedin/inmail-credits
  if (clean === "linkedin/recruiter/inmail-credits") {
    return "linkedin/inmail-credits";
  }

  // ── Recruiter projects/jobs (already v1-shaped) ──────────────────
  if (clean.startsWith("linkedin/projects")
    || clean.startsWith("linkedin/jobs")
    || clean.startsWith("linkedin/contracts")
    || clean.startsWith("linkedin/search")
    || clean.startsWith("linkedin/inmail-credits")) {
    return clean;
  }

  // ── Messaging (top-level on v1) ───────────────────────────────────
  // v2: chats, chats/{id}, chats/{id}/messages → v1: same path
  // v2: messages, messages/{id} → v1: same path
  // v2: emails → v1: same path
  if (clean.startsWith("chats")
    || clean.startsWith("messages")
    || clean.startsWith("emails")
    || clean.startsWith("calendars/")) {
    return clean;
  }

  // ── Proxy config ─────────────────────────────────────────────────
  // v2: proxy → no v1 equivalent (proxy is a v2-only concept).
  if (clean === "proxy") {
    return null;
  }

  // Pass-through anything we don't recognise — caller will see the
  // raw v1 URL and we'll fix the rule when we hit a 404.
  return clean;
}

export interface UnipileFetchInit extends Omit<RequestInit, "headers"> {
  query?: Record<string, string | number | undefined>;
  /** Extra headers merged on top of auth/Accept defaults. */
  headers?: Record<string, string>;
  /**
   * Legacy v2-era flag. Ignored on v1 — every v1 LinkedIn / messaging
   * route already takes account_id as a query parameter. Kept here so
   * existing call sites don't have to be touched.
   */
  topLevel?: boolean;
}

/**
 * Fetch any Unipile endpoint scoped to a single account_id. Throws on
 * non-2xx with the response body in the message.
 *
 * Callers historically wrote v2-shaped paths
 * (e.g. `linkedin/users/{slug}`, `chats`, `inboxes/.../chats/send`).
 * Those paths are translated to their v1 equivalents below and
 * account_id is added as a query parameter (NOT a path segment).
 *
 * Example:
 *   await unipileFetch(supabase, accountId, "linkedin/users/jane-doe")
 *   →  GET {v1Base}/users/jane-doe?account_id={accountId}
 */
export async function unipileFetch<T = any>(
  supabase: any,
  accountId: string,
  path: string,
  init: UnipileFetchInit = {},
): Promise<T> {
  if (!accountId) throw new Error("unipileFetch: accountId required");
  const v1Path = translatePathToV1(path);
  if (v1Path === null) {
    throw new Error(
      `unipileFetch: no v1 equivalent for "${path}". `
      + `This endpoint was v2-only and our v2 app lacks the scope. `
      + `Caller should 501 or fall back to a v1 route.`,
    );
  }

  const { base, apiKey } = await resolveConfig(supabase);
  const cleanPath = v1Path.replace(/^\/+/, "");

  // Preserve a query string the caller embedded in `path`.
  const [pathPart, embeddedQs = ""] = cleanPath.split("?");
  const url = new URL(`${base}/${pathPart}`);
  if (embeddedQs) {
    const parsed = new URLSearchParams(embeddedQs);
    for (const [k, v] of parsed.entries()) url.searchParams.set(k, v);
  }
  url.searchParams.set("account_id", accountId);
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
 * label) to the canonical bucket we use in messages.channel. Four
 * buckets total:
 *
 *   email                                → email
 *   sms                                  → sms
 *   regular LinkedIn DMs (Classic)        → linkedin
 *   Recruiter InMail                      → linkedin_recruiter
 */
export function canonicalChannel(channel: string | null | undefined): string {
  const c = String(channel || "").toLowerCase();
  if (c === "email" || c === "sms") return c;
  if (c === "linkedin_inmail" || c === "linkedin_recruiter" || c === "recruiter_inmail") return "linkedin_recruiter";
  if (
    c === "linkedin" ||
    c === "linkedin_message" ||
    c === "linkedin_connection" ||
    c === "linkedin_classic"
  ) return "linkedin";
  // Pass-through for anything we don't recognise; logs surface it.
  return c || "unknown";
}

// ─────────────────────────────────────────────────────────────────────
//  Unipile v2 (api.unipile.com/v2) — LinkedIn Recruiter migration.
//
//  Unlike v1 (this file's legacy default), v2:
//    - is hosted at UNIPILE_BASE_V2_URL (https://api.unipile.com/v2)
//    - authenticates with UNIPILE_API_KEY_V2
//    - takes account_id as a PATH SEGMENT: /v2/{acc_xxx}/<resource>
//    - requires the canonical acc_xxx id (NOT the short v1 id), stored in
//      integration_accounts.unipile_account_id_v2
//
//  Everything here is gated by the UNIPILE_LINKEDIN_V2 app_setting so the
//  working v1 path is unaffected until the v2 Recruiter scope is proven.
// ─────────────────────────────────────────────────────────────────────

interface ResolvedConfigV2 {
  v2Base: string;
  apiKeyV2: string;
}

let _cachedConfigV2: { value: ResolvedConfigV2; fetchedAt: number } | null = null;

async function resolveConfigV2(supabase: any): Promise<ResolvedConfigV2> {
  const now = Date.now();
  if (_cachedConfigV2 && now - _cachedConfigV2.fetchedAt < CONFIG_TTL_MS) {
    return _cachedConfigV2.value;
  }
  const [{ data: baseRow }, { data: keyRow }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const v2Base = (baseRow?.value || "").replace(/\/+$/, "") || "https://api.unipile.com/v2";
  // Fall back to the v1 key only so calls fail with a clear 401 rather than a
  // config error; the v2 surface really wants UNIPILE_API_KEY_V2.
  const apiKeyV2 = keyRow?.value || v1KeyRow?.value;
  if (!apiKeyV2) throw new Error("Unipile v2 config missing (UNIPILE_API_KEY_V2)");
  const value = { v2Base, apiKeyV2 };
  _cachedConfigV2 = { value, fetchedAt: now };
  return value;
}

/**
 * Is the LinkedIn-Recruiter-on-v2 flag enabled? Cached briefly. Defaults to
 * false (legacy v1) when the row is missing or unparseable.
 */
let _cachedV2Flag: { value: boolean; fetchedAt: number } | null = null;
export async function isLinkedinV2Enabled(supabase: any): Promise<boolean> {
  const now = Date.now();
  if (_cachedV2Flag && now - _cachedV2Flag.fetchedAt < CONFIG_TTL_MS) {
    return _cachedV2Flag.value;
  }
  const { data } = await supabase
    .from("app_settings").select("value").eq("key", "UNIPILE_LINKEDIN_V2").maybeSingle();
  const raw = String(data?.value ?? "").trim().toLowerCase();
  const value = raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  _cachedV2Flag = { value, fetchedAt: now };
  return value;
}

/**
 * Is the LinkedIn-**send**-on-v2 flag enabled? Separate kill-switch from
 * isLinkedinV2Enabled (which gates Recruiter project/pipeline writes): this
 * one gates the outbound DM / connection-invite / Recruiter-InMail SEND path
 * and the connection-status poll. Cached briefly. Defaults to false (legacy
 * v1) when the row is missing or unparseable.
 *
 * NOTE: the v2 SEND body shapes this flag unlocks are NOT yet verified — do
 * not flip app_settings.USE_LINKEDIN_V2_SEND on until they're confirmed
 * against Unipile's v2 Methods reference.
 */
let _cachedV2SendFlag: { value: boolean; fetchedAt: number } | null = null;
export async function isLinkedinV2SendEnabled(supabase: any): Promise<boolean> {
  const now = Date.now();
  if (_cachedV2SendFlag && now - _cachedV2SendFlag.fetchedAt < CONFIG_TTL_MS) {
    return _cachedV2SendFlag.value;
  }
  const { data } = await supabase
    .from("app_settings").select("value").eq("key", "USE_LINKEDIN_V2_SEND").maybeSingle();
  const raw = String(data?.value ?? "").trim().toLowerCase();
  const value = raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  _cachedV2SendFlag = { value, fetchedAt: now };
  return value;
}

/**
 * Fetch a Unipile **v2** endpoint scoped to a canonical acc_xxx id. Mirrors
 * unipileFetch() but builds `${v2Base}/${acctV2Id}/${path}` with account_id
 * as a path segment and authenticates with UNIPILE_API_KEY_V2.
 *
 * Example:
 *   await unipileFetchV2(supabase, "acc_123", "linkedin/recruiter/projects",
 *     { method: "POST", body: JSON.stringify({ name, visibility }) })
 *   →  POST {v2Base}/acc_123/linkedin/recruiter/projects
 */
export async function unipileFetchV2<T = any>(
  supabase: any,
  acctV2Id: string,
  path: string,
  init: UnipileFetchInit = {},
): Promise<T> {
  if (!acctV2Id) throw new Error("unipileFetchV2: acctV2Id (acc_xxx) required");
  const { v2Base, apiKeyV2 } = await resolveConfigV2(supabase);
  const cleanPath = path.replace(/^\/+/, "");
  const [pathPart, embeddedQs = ""] = cleanPath.split("?");
  const url = new URL(`${v2Base}/${encodeURIComponent(acctV2Id)}/${pathPart}`);
  if (embeddedQs) {
    const parsed = new URLSearchParams(embeddedQs);
    for (const [k, v] of parsed.entries()) url.searchParams.set(k, v);
  }
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "X-API-KEY": apiKeyV2,
    Accept: "application/json",
    ...(init.headers || {}),
  };
  if (typeof init.body === "string" && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url.toString(), { ...init, headers });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Unipile v2 ${resp.status} ${path}: ${text.slice(0, 300)}`);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/**
 * Resolve the canonical v2 account id (acc_xxx) for a Sully user + provider.
 * Returns null when not yet captured — callers must fall back to v1 or
 * trigger a backfill (GET {v2Base}/accounts).
 */
export async function getUnipileAccountV2IdForUser(
  supabase: any,
  ownerUserId: string,
  provider: "LINKEDIN" | "OUTLOOK" | "GMAIL" | string,
): Promise<string | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id_v2")
    .eq("owner_user_id", ownerUserId)
    .eq("unipile_provider", provider)
    .not("unipile_account_id_v2", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.unipile_account_id_v2 ?? null;
}

/** Resolve the v2 acc_xxx id from the short-form v1 id we already store. */
export async function getUnipileAccountV2IdByV1Id(
  supabase: any,
  shortV1Id: string,
): Promise<string | null> {
  if (!shortV1Id) return null;
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id_v2")
    .eq("unipile_account_id", shortV1Id)
    .not("unipile_account_id_v2", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.unipile_account_id_v2 ?? null;
}

void logger; // tree-shake guard for the import
