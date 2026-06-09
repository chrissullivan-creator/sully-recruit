/**
 * Unipile URL helpers — single source of truth.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Unipile API surface (as of May 2026, verified against
 *  https://api.unipile.com/v2/docs/json and direct DSN probes)
 * ─────────────────────────────────────────────────────────────────────
 *
 *  v2 — global host (api.unipile.com/v2), uses UNIPILE_API_KEY_V2
 *    /v2/accounts/                  POST   create connected account
 *    /v2/accounts/{id}              GET PATCH DELETE
 *    /v2/auth/checkpoint            POST   solve checkpoint
 *    /v2/auth/intent                POST   start auth intent
 *    /v2/auth/link                  POST   hosted-auth link
 *    /v2/webhooks/conversations/    GET POST
 *    /v2/webhooks/endpoints/        GET POST
 *    /v2/webhooks/endpoints/{id}    GET PATCH DELETE
 *
 *  Everything else lives on v1 (DSN-hosted), uses UNIPILE_API_KEY.
 *  v2 has NO linkedin/recruiter/messaging/email/search endpoints.
 *  (This is Unipile's design, not ours — we cannot move LinkedIn
 *  endpoints to v2 because Unipile hasn't built them there yet.)
 *
 *  v1 — tenant DSN (api19.unipile.com:14926/api/v1), uses UNIPILE_API_KEY
 *    /api/v1/accounts                                 GET POST DELETE
 *    /api/v1/accounts/{account_id}                    GET
 *    /api/v1/linkedin/projects                        GET   list hiring projects
 *    /api/v1/linkedin/projects/{project_id}           GET   project detail
 *    /api/v1/linkedin/jobs                            GET   list job postings
 *    /api/v1/linkedin/jobs/{job_id}                   GET   job posting detail
 *    /api/v1/linkedin/jobs/{job_id}/applicants        GET   applicants for a job
 *    /api/v1/linkedin/jobs/applicants/{applicant_id}  GET   applicant detail
 *    /api/v1/linkedin/jobs/applicants/{aid}/resume    GET   applicant resume (PDF)
 *    /api/v1/linkedin/contracts                       GET   recruiter contracts
 *    /api/v1/linkedin/search                          POST  unified search
 *    /api/v1/linkedin/search/parameters               POST  resolve search params
 *    All v1 LinkedIn endpoints take ?account_id=X as a query parameter.
 *
 *  Reasoning recap for future readers:
 *    - The old code referenced /v2/{acct}/linkedin/recruiter/...
 *      which never existed at any Unipile host. The 401 "Invalid
 *      API Key" we got was Unipile's misleading way of reporting
 *      "wrong route", not auth failure.
 *    - The tenant DSN does NOT serve /api/v2 — probed and confirmed
 *      to return 404 "Cannot GET /api/v2/..."
 *    - api.unipile.com only handles the 8 v2 lifecycle endpoints
 *      above; it returns 404 "Route Not Found" for everything else.
 */

export interface UnipileBases {
  /** Tenant DSN, e.g. https://api19.unipile.com:14926/api/v1 — for all LinkedIn / messaging / email calls. */
  v1Base: string;
  /** Tenant API key — pairs with v1Base. */
  apiKey: string;
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

// ── Unipile v2 (api.unipile.com/v2) path templates ───────────────────
// v2 takes account_id as a PATH segment, so these are the *suffix* placed
// after `${v2Base}/${acc_xxx}/`. Pass them to unipileFetchV2() in
// src/server-lib/unipile-v2.ts (which prepends the base + acc_xxx + key).
//
// Recruiter project/pipeline/search shapes follow Unipile's published v2
// recruiter controller. They are NOT yet confirmed live against our app —
// run /api/admin/probe-unipile-recruiter (v2 section) to verify status
// codes and exact paths before flipping UNIPILE_LINKEDIN_V2 on.
export const recruiterV2 = {
  projects: () => "linkedin/recruiter/projects",
  projectDetail: (projectId: string) =>
    `linkedin/recruiter/projects/${encodeURIComponent(projectId)}`,
  pipelineSave: (projectId: string) =>
    `linkedin/recruiter/projects/${encodeURIComponent(projectId)}/pipeline/candidate/save`,
  talentPoolApplicants: (projectId: string) =>
    `linkedin/recruiter/projects/${encodeURIComponent(projectId)}/talent-pool/applicants`,
  inmailCredits: () => "linkedin/recruiter/inmail-credits",
  searchPeople: () => "linkedin/recruiter/search/people",
};

// ── Unipile v2 SEND/messaging path templates ─────────────────────────
// Like `recruiterV2`, these are the *suffix* placed after
// `${v2Base}/${acc_xxx}/` and are passed to unipileFetchV2() in
// src/server-lib/unipile-v2.ts (which prepends base + acc_xxx + key).
//
// READS at these paths are verified live (see backfill-linkedin-messages-v2.ts:
// GET inboxes, GET inboxes/{id}/chats, GET chats/{id}/messages). The SEND
// (POST) shapes below are INFERRED from the v1 send bodies + the v2 read
// shapes and are NOT yet confirmed against Unipile's v2 Methods reference.
// Each call site that POSTs to one of these carries a
// `TODO(verify v2 body shape before enabling USE_LINKEDIN_V2_SEND)` comment.
// Verify status codes + body shapes before flipping USE_LINKEDIN_V2_SEND on.
export const messagingV2 = {
  /** Send a message into an existing chat: POST chats/{chat_id}/messages, body { text }. */
  chatMessages: (chatId: string) =>
    `chats/${encodeURIComponent(chatId)}/messages`,
  /** Start a new chat / first message to a member: POST chats, body { attendees_ids|recipients, text }. */
  chats: () => "chats",
  /** Connection invitation: POST users/invite, body { provider_id|identifier, message }. */
  usersInvite: () => "users/invite",
  /** LinkedIn member lookup / connection status: GET users/{provider_id}. */
  user: (providerId: string) => `users/${encodeURIComponent(providerId)}`,
};
