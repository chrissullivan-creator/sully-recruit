# Sully Recruit — Unipile v2 API Reference
> **FOR CLAUDE CODE USE**: This document is the single source of truth for all Unipile API usage in Sully Recruit.
> **CRITICAL**: Sully Recruit uses ONLY Unipile v2. There is NO v1 code. If you see any v1 endpoint patterns (DSN-based URLs, `account_type` params, unified listing routes), replace them with v2 equivalents below.

## Base URL
```
https://api.unipile.com/v2
```
All routes relative to this base. Every route begins with `/:account_id/`.

## Auth
```
Header: X-API-KEY: <your_v2_api_key>
```

## Key v1 vs v2 differences
| v1 (LEGACY) | v2 (USE THIS) |
|---|---|
| DSN base URL | `https://api.unipile.com/v2` |
| `?account_id=` query param | `/:account_id/` in path |
| `UNIPILE_API_KEY` (v1 token) | `UNIPILE_API_KEY_V2` |

## Connect: POST /v2/auth/link
## Email: GET/POST /v2/:account_id/emails
## Chats: GET/POST /v2/:account_id/chats
## Recruiter chats: GET/POST /v2/:account_id/linkedin/recruiter/chats
## User profile: GET /v2/:account_id/linkedin/users/:user_id
## Search: POST /v2/:account_id/linkedin/search/people
## Recruiter search: POST /v2/:account_id/linkedin/recruiter/search/candidates
## Projects: GET /v2/:account_id/linkedin/recruiter/projects
## Jobs: GET /v2/:account_id/linkedin/jobs (classic) or /recruiter/jobs
## Invites: POST /v2/:account_id/users/me/relation-requests
## Webhooks: POST /v2/webhooks (NOT account-scoped)

See full reference in the user-provided doc (this is the summary).
