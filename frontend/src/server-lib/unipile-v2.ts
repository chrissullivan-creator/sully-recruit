/**
 * Central Unipile client. Every server-side caller routes through here
 * so the URL shape and key resolution are defined in one place.
 *
 * This module now routes ALL calls to Unipile v2:
 *   - Base URL: https://api.unipile.com/v2
 *   - Auth: X-API-KEY = UNIPILE_API_KEY_V2
 *   - Account targeting: account_id in the URL path (/v2/{accountId}/resource)
 *   - Account IDs: acc_xxx format (from integration_accounts.metadata->>'unipile_account_id_v2')
 *
 * The path translation below converts caller-facing path strings into
 * v2-shaped paths (account_id in path, not query param).
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
  const [{ data: v2Row }, { data: v2KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
  ]);
  const base = (v2Row?.value || "").replace(/\/+$/, "")
    || "https://api.unipile.com/v2";
  const apiKey = v2KeyRow?.value;
  if (!base || !apiKey) throw new Error("Unipile config missing (UNIPILE_BASE_V2_URL or UNIPILE_API_KEY_V2)");
  const value = { base, apiKey };
  _cachedConfig = { value, fetchedAt: now };
  return value;
}

/**
 * Translate a caller-facing path into the canonical v2 path shape.
 * v2 puts account_id in the URL path (added by `unipileFetch`), so
 * these translations just normalize the resource path.
 *
 * Returns null when there is no v2 equivalent (caller should 501).
 */
export function translatePathToV2(path: string): string | null {
  const clean = path.replace(/^\/+/, "");

  // ── LinkedIn user lookups ─────────────────────────────────────────
  // Caller: linkedin/users/{slug} → v2: linkedin/users/{slug}
  // Caller: linkedin/users/invite → v2: users/me/relation-requests (POST)
  if (clean.startsWith("linkedin/users/invitations/")) {
    // linkedin/users/invitations/received → users/me/relation-requests?type=received
    const rest = clean.replace(/^linkedin\/users\/invitations\//, "");
    return `users/me/relation-requests?type=${rest}`;
  }
  if (clean === "linkedin/users/invite" || clean.startsWith("linkedin/users/invite?")) {
    return "users/me/relation-requests";
  }
  if (clean.startsWith("linkedin/users/")) {
    // linkedin/users/{slug} → linkedin/users/{slug} (same on v2)
    return clean;
  }
  if (clean.startsWith("users/invitations/")) {
    const rest = clean.replace(/^users\/invitations\//, "");
    return `users/me/relation-requests?type=${rest}`;
  }
  if (clean === "users/invite/received" || clean === "users/invite/sent") {
    const type = clean.endsWith("received") ? "received" : "sent";
    return `users/me/relation-requests?type=${type}`;
  }
  if (clean === "users/invite" || clean.startsWith("users/invite?")) {
    return "users/me/relation-requests";
  }

  // ── LinkedIn search ───────────────────────────────────────────────
  // Caller: linkedin/search → v2: linkedin/search/people (classic)
  //   OR linkedin/recruiter/search/candidates (recruiter — body decides)
  if (clean === "linkedin/search" || clean.startsWith("linkedin/search?")) {
    // Body { api:'recruiter' } → recruiter path; default → classic
    // We use a single path and let the body determine — caller should
    // switch to the recruiter path if needed. Default to recruiter search.
    return "linkedin/recruiter/search/candidates";
  }
  if (clean === "linkedin/recruiter/search/people"
    || clean.startsWith("linkedin/recruiter/search/people?")
    || clean === "linkedin/recruiter/search/candidates") {
    return "linkedin/recruiter/search/candidates";
  }

  // ── LinkedIn search parameters ────────────────────────────────────
  if (clean === "linkedin/search/parameters" || clean.startsWith("linkedin/search/parameters?")) {
    return "linkedin/recruiter/search-parameters";
  }

  // ── Recruiter InMail credits ──────────────────────────────────────
  // TODO: v2 does not have a direct /inmail-credits endpoint; check account detail instead
  if (clean === "linkedin/recruiter/inmail-credits" || clean === "linkedin/inmail-credits") {
    return "linkedin/recruiter/inmail-credits";
  }

  // ── Recruiter projects ────────────────────────────────────────────
  if (clean === "linkedin/projects" || clean.startsWith("linkedin/projects?")) {
    return "linkedin/recruiter/projects";
  }
  if (clean.match(/^linkedin\/projects\/[^/]+$/)) {
    const id = clean.replace(/^linkedin\/projects\//, "");
    return `linkedin/recruiter/projects/${id}`;
  }

  // ── LinkedIn jobs + applicants ────────────────────────────────────
  if (clean.startsWith("linkedin/jobs")) {
    return clean; // v2 keeps the same path shape
  }

  // ── LinkedIn contracts ────────────────────────────────────────────
  if (clean.startsWith("linkedin/contracts")) {
    return clean; // v2 keeps the same path shape
  }

  // ── Inbox-scoped recruiter send ───────────────────────────────────
  if (clean.startsWith("inboxes/")) {
    return null; // No direct equivalent; caller falls back to /chats
  }

  // ── Messaging ─────────────────────────────────────────────────────
  // v2: chats, chats/{id}, emails → same resource paths under /{accountId}/
  if (clean.startsWith("chats")
    || clean.startsWith("messages")
    || clean.startsWith("emails")
    || clean.startsWith("calendars/")) {
    return clean;
  }

  // ── Proxy config ─────────────────────────────────────────────────
  if (clean === "proxy") {
    return null;
  }

  // Pass-through anything we don't recognise.
  return clean;
}

export interface UnipileFetchInit extends Omit<RequestInit, "headers"> {
  query?: Record<string, string | number | undefined>;
  /** Extra headers merged on top of auth/Accept defaults. */
  headers?: Record<string, string>;
  /**
   * Legacy flag. On v2, when true, omits account_id from the path
   * (for non-account-scoped routes like /accounts, /auth, /webhooks).
   */
  topLevel?: boolean;
}

/**
 * Fetch any Unipile endpoint scoped to a single account_id via v2.
 * Throws on non-2xx with the response body in the message.
 *
 * v2 URL shape: {v2Base}/{accountId}/{path}
 *   - account_id is in the PATH, not a query parameter
 *   - Auth: X-API-KEY = UNIPILE_API_KEY_V2
 *
 * Example:
 *   await unipileFetch(supabase, "acc_xxx", "linkedin/users/jane-doe")
 *   →  GET https://api.unipile.com/v2/acc_xxx/linkedin/users/jane-doe
 */
export async function unipileFetch<T = any>(
  supabase: any,
  accountId: string,
  path: string,
  init: UnipileFetchInit = {},
): Promise<T> {
  if (!accountId) throw new Error("unipileFetch: accountId required");
  const v2Path = translatePathToV2(path);
  if (v2Path === null) {
    throw new Error(
      `unipileFetch: no v2 equivalent for "${path}". `
      + `Caller should 501 or fall back gracefully.`,
    );
  }

  const { base, apiKey } = await resolveConfig(supabase);
  const cleanPath = v2Path.replace(/^\/+/, "");

  // Preserve a query string the caller embedded in the translated path.
  const [pathPart, embeddedQs = ""] = cleanPath.split("?");
  // v2: account_id goes in the path segment
  const acctSegment = init.topLevel ? "" : `/${accountId}`;
  const url = new URL(`${base}${acctSegment}/${pathPart}`);
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

void logger; // tree-shake guard for the import
