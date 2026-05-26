/**
 * Unipile URL helpers — single source of truth.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Unipile API surface (May 2026)
 * ─────────────────────────────────────────────────────────────────────
 *
 *  All calls now use v2 — global host (api.unipile.com/v2),
 *  uses UNIPILE_API_KEY_V2. Account-scoped routes put account_id
 *  in the path: /v2/{accountId}/resource.
 *
 *  v2 routes:
 *    /v2/accounts/                                          POST   create account
 *    /v2/accounts/{id}                                      GET PATCH DELETE
 *    /v2/auth/checkpoint                                    POST   solve checkpoint
 *    /v2/auth/intent                                        POST   cookie auth
 *    /v2/auth/link                                          POST   hosted-auth link
 *    /v2/{acct}/linkedin/users/{slug}                       GET    profile lookup
 *    /v2/{acct}/linkedin/recruiter/projects                 GET    hiring projects
 *    /v2/{acct}/linkedin/recruiter/projects/{id}            GET    project detail
 *    /v2/{acct}/linkedin/recruiter/search/candidates        POST   recruiter search
 *    /v2/{acct}/linkedin/recruiter/search-parameters        POST   search params
 *    /v2/{acct}/linkedin/jobs                               GET    job postings
 *    /v2/{acct}/linkedin/jobs/{id}/applicants               POST   applicants
 *    /v2/{acct}/linkedin/contracts                          GET    contracts
 *    /v2/{acct}/chats                                       GET/POST  messaging
 *    /v2/{acct}/emails                                      GET/POST  email
 *    /v2/{acct}/calendars/events                            GET    calendar
 *    /v2/{acct}/users/me/relation-requests                  GET    invitations
 *
 *  v1 helpers below are kept for backward compatibility but marked
 *  @deprecated. New code should use linkedinV2 named routes.
 */

export interface UnipileBases {
  /** Tenant DSN, e.g. https://api19.unipile.com:14926/api/v1 — LEGACY, being migrated to v2. */
  v1Base: string;
  /** v1 API key — pairs with v1Base. LEGACY. */
  apiKey: string;
}

// ── v2 helpers ──────────────────────────────────────────────────────
// v2 base: https://api.unipile.com/v2
// v2 routes put account_id in the PATH: /v2/{accountId}/resource
// v2 uses UNIPILE_API_KEY_V2, NOT the v1 key.

export interface UnipileV2Bases {
  v2Base: string;
  apiKeyV2: string;
}

/**
 * Build a v2 URL. Account-scoped routes: /v2/{accountId}/path.
 * Non-account routes (auth, webhooks): /v2/path.
 */
export function v2Url(
  bases: UnipileV2Bases,
  accountId: string | null,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const acctSegment = accountId ? `/${accountId}` : "";
  const qsStr = qs.toString();
  return `${bases.v2Base}${acctSegment}${cleanPath}${qsStr ? `?${qsStr}` : ""}`;
}

export function v2Headers(bases: UnipileV2Bases, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-API-KEY": bases.apiKeyV2,
    Accept: "application/json",
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

/**
 * Build the URL for a v1 LinkedIn endpoint. All v1 LinkedIn routes
 * take account_id as a query parameter (not in the path).
 */
export function v1Url(
  bases: UnipileBases,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const qsStr = qs.toString();
  return `${bases.v1Base}${cleanPath}${qsStr ? `?${qsStr}` : ""}`;
}

/** Standard X-API-KEY header used on every Unipile call. */
export function unipileHeaders(bases: UnipileBases, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-API-KEY": bases.apiKey,
    Accept: "application/json",
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

// ── Named route builders (kept here so all LinkedIn URLs are
//    visible in one place) ────────────────────────────────────────

/** @deprecated Use linkedinV2 instead — v1 routes are being retired. */
export const linkedinV1 = {
  listProjects: (b: UnipileBases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v1Url(b, "/linkedin/projects", { account_id: accountId, ...q }),

  projectDetail: (b: UnipileBases, accountId: string, projectId: string) =>
    v1Url(b, `/linkedin/projects/${encodeURIComponent(projectId)}`, { account_id: accountId }),

  listJobs: (b: UnipileBases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v1Url(b, "/linkedin/jobs", { account_id: accountId, ...q }),

  jobDetail: (b: UnipileBases, accountId: string, jobId: string) =>
    v1Url(b, `/linkedin/jobs/${encodeURIComponent(jobId)}`, { account_id: accountId }),

  jobApplicants: (b: UnipileBases, accountId: string, jobId: string, q: Record<string, string | number | undefined> = {}) =>
    v1Url(b, `/linkedin/jobs/${encodeURIComponent(jobId)}/applicants`, { account_id: accountId, ...q }),

  applicantDetail: (b: UnipileBases, accountId: string, applicantId: string) =>
    v1Url(b, `/linkedin/jobs/applicants/${encodeURIComponent(applicantId)}`, { account_id: accountId }),

  applicantResume: (b: UnipileBases, accountId: string, applicantId: string) =>
    v1Url(b, `/linkedin/jobs/applicants/${encodeURIComponent(applicantId)}/resume`, { account_id: accountId }),

  contracts: (b: UnipileBases, accountId: string) =>
    v1Url(b, "/linkedin/contracts", { account_id: accountId }),

  searchParameters: (b: UnipileBases, accountId: string) =>
    v1Url(b, "/linkedin/search/parameters", { account_id: accountId }),

  search: (b: UnipileBases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v1Url(b, "/linkedin/search", { account_id: accountId, ...q }),

  accountDetail: (b: UnipileBases, accountId: string) =>
    v1Url(b, `/accounts/${encodeURIComponent(accountId)}`),

  listAccounts: (b: UnipileBases, q: Record<string, string | number | undefined> = {}) =>
    v1Url(b, "/accounts", q),
};

/**
 * v2 named route builders. Account ID goes in the path, not query params.
 * Uses UNIPILE_API_KEY_V2 and acc_xxx format IDs.
 */
export const linkedinV2 = {
  listProjects: (b: UnipileV2Bases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, "/linkedin/recruiter/projects", q),

  projectDetail: (b: UnipileV2Bases, accountId: string, projectId: string) =>
    v2Url(b, accountId, `/linkedin/recruiter/projects/${encodeURIComponent(projectId)}`),

  listJobs: (b: UnipileV2Bases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, "/linkedin/jobs", q),

  jobDetail: (b: UnipileV2Bases, accountId: string, jobId: string) =>
    v2Url(b, accountId, `/linkedin/jobs/${encodeURIComponent(jobId)}`),

  jobApplicants: (b: UnipileV2Bases, accountId: string, jobId: string, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, `/linkedin/jobs/${encodeURIComponent(jobId)}/applicants`, q),

  applicantDetail: (b: UnipileV2Bases, accountId: string, jobId: string, applicantId: string) =>
    v2Url(b, accountId, `/linkedin/jobs/${encodeURIComponent(jobId)}/applicants/${encodeURIComponent(applicantId)}`),

  applicantResume: (b: UnipileV2Bases, accountId: string, jobId: string, applicantId: string) =>
    v2Url(b, accountId, `/linkedin/jobs/${encodeURIComponent(jobId)}/applicants/${encodeURIComponent(applicantId)}/resume`),

  contracts: (b: UnipileV2Bases, accountId: string) =>
    v2Url(b, accountId, "/linkedin/contracts"),

  searchParameters: (b: UnipileV2Bases, accountId: string) =>
    v2Url(b, accountId, "/linkedin/recruiter/search-parameters"),

  searchCandidates: (b: UnipileV2Bases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, "/linkedin/recruiter/search/candidates", q),

  searchPeople: (b: UnipileV2Bases, accountId: string, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, "/linkedin/search/people", q),

  userProfile: (b: UnipileV2Bases, accountId: string, slug: string) =>
    v2Url(b, accountId, `/linkedin/users/${encodeURIComponent(slug)}`),

  accountDetail: (b: UnipileV2Bases, accountId: string) =>
    v2Url(b, null, `/accounts/${encodeURIComponent(accountId)}`),

  listAccounts: (b: UnipileV2Bases, q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, null, "/accounts", q),

  relationRequests: (b: UnipileV2Bases, accountId: string, type: "received" | "sent", q: Record<string, string | number | undefined> = {}) =>
    v2Url(b, accountId, "/users/me/relation-requests", { type, ...q }),
};
