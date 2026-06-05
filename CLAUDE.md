# Sully Recruit — Claude Code Context

## Quick Reference

- **Project:** Sully Recruit CRM/ATS for The Emerald Recruiting Group
- **Supabase project:** `xlobevmhzimxjtpiontf`
- **Repo:** chrissullivan-creator/sully-recruit
- **Deploy:** Push to `main` → Vercel auto-deploys frontend + Inngest functions
- **Background jobs:** Inngest only (`inngest` in `package.json`). The `src/server-lib/` directory holds shared backend helpers used by both API endpoints and Inngest functions; the older `src/trigger/` name was a holdover from a Trigger.dev evaluation that never shipped.

## MCP Servers

All configured in `.mcp.json`. Restart session if disconnected.

- **Supabase** — SQL, migrations, schema (token: supabase.com/dashboard/account/tokens)
- **Unipile** — LinkedIn API (DSN: api19.unipile.com:14926)

## Skills

Read these before making changes:

- `claude/SKILL-architecture.md` — DB schema, API patterns, secrets, common mistakes
- `claude/SKILL-frontend.md` — React components, routing, UI patterns
- `claude/SKILL-webhooks.md` — Webhook handlers, Unipile/Microsoft/RingCentral
- `claude/SKILL-sequences.md` — Sequence engine, enrollment logic
- `claude/SKILL-joe.md` — AI assistant (Joe) behavior
- `claude/SKILL-calls.md` — RingCentral call handling

## Key Rules

- AI cascade lives in `frontend/src/lib/ai-fallback.ts:callAIWithFallback`. Four providers, opt in by passing the matching key; default order **Claude → OpenAI → Gemini → OpenRouter**, overridable per call via `order`. **Resume parsing leads with OpenAI** (`RESUME_PARSE_ORDER` = OpenAI → Claude → Gemini → OpenRouter) — applied in `parse-resume-ai.ts`, `resume-ingestion.ts`, `reparse-resumes.ts`, `reconcile-orphaned-resumes.ts`. All surfaces (resume parsing, email-signature parsing, drafting, chat, sentiment, matching) pass all four keys. `parse-resume.ts` is self-contained (its own inlined cascade, OpenAI → Claude → Gemini → OpenRouter for resumes — Vercel bundler can't follow the shared import). No Eden AI, no Lovable gateway.
- Unipile API key comes from `app_settings` table via `getAppSetting("UNIPILE_API_KEY")` — NOT from `integration_accounts.access_token`
- Edge function secrets: `ANTHROPIC_API_KEY` (check lowercase fallback `anthropic_api_key`)
- Frontend env vars must be `VITE_*` prefixed
- **Unified person model:** `candidates` table holds BOTH candidates and clients via `type` column (`'candidate'` | `'client'`). The old `contacts` table is now a backwards-compat VIEW over `candidates WHERE type='client'` with INSTEAD OF triggers for writes.
- Person statuses (shared candidate + client): `new`, `reached_out`, `engaged` — nothing else (CHECK constraint enforces this)
- Pipeline stage tables: `pitches`, `send_outs`, `submissions`, `interviews`, `placements`, `rejections`
- Ashley has email and LinkedIn but NO RingCentral — no SMS routing for Ashley

## Unipile API — the v1/v2 split (read before touching LinkedIn/messaging code)

Unipile publishes two API spec scopes; they are NOT interchangeable. The whole codebase calls **v1** for behavior and v2 for lifecycle. Centralized helper: `frontend/api/lib/unipile-urls.ts` (the file header is the canonical reference).

| Concern | API | Host | API key | Pattern |
|---|---|---|---|---|
| **Methods** (LinkedIn, Recruiter, messaging, email, calendar, search, contracts) | **v1** | tenant DSN (`api19.unipile.com:14926/api/v1`) | `UNIPILE_API_KEY` | `${v1Base}/<path>?account_id=X` — account_id is a **query param**, never a path segment |
| **Lifecycle** (account create via Hosted Auth, auth checkpoint, webhooks) | v2 | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | `${v2Base}/<path>` |

### Common mistakes to avoid

- **Do NOT call `api.unipile.com/v2/{acct}/linkedin/...`.** The v2 Methods API exists in Unipile's published docs but our app `app_01kr071epafvjsg64xdb2edgfz` gets **403 "Insufficient permissions"** on every Recruiter call. Open a Unipile support ticket if you want this unblocked. Until then, every LinkedIn call must hit v1.
- **Do NOT swap the API keys.** `UNIPILE_API_KEY` (v1) gets 401 on the v2 host; `UNIPILE_API_KEY_V2` gets 401 on the v1 DSN. They're scoped to different applications.
- **Do NOT use `acc_xxx` IDs against v1.** v1 returns 404 "Account not found" for canonical `acc_xxx` IDs. v1 uses the SHORT format (e.g. `1Ti3bx-8RrC0B91qxp_9ww`); v2 uses `acc_xxx`. Same underlying account, different ID per API. DB stores both:
  - `integration_accounts.unipile_account_id` = short-form (for v1)
  - `integration_accounts.metadata.unipile_account_id_v2` = canonical `acc_xxx` (for the future v2 flip)
- **The old `${v2Base}/${acct}/linkedin/recruiter/...` pattern in our code never worked.** Don't reintroduce it. The 401 "Invalid API Key" it threw was Unipile's misleading shorthand for "wrong route" — not auth failure.

### Confirmed v1 routes (probed against live API, May 2026)

```
GET  /api/v1/accounts                         list connected accounts
GET  /api/v1/accounts/{short_id}              account detail
GET  /api/v1/linkedin/projects?account_id=X   Recruiter hiring projects
GET  /api/v1/linkedin/projects/{id}?account_id=X
GET  /api/v1/linkedin/jobs?account_id=X
GET  /api/v1/linkedin/jobs/{job_id}?account_id=X
GET  /api/v1/linkedin/jobs/{job_id}/applicants?account_id=X
GET  /api/v1/linkedin/jobs/applicants/{aid}?account_id=X
GET  /api/v1/linkedin/jobs/applicants/{aid}/resume?account_id=X  (returns PDF)
GET  /api/v1/linkedin/contracts?account_id=X
POST /api/v1/linkedin/contracts/{cid}/select?account_id=X
POST /api/v1/linkedin/search?account_id=X     body: { api:'recruiter', category:'people', ... }
POST /api/v1/linkedin/search/parameters?account_id=X  body: { type:'LOCATION'|'COMPANY'|..., keywords }
GET  /api/v1/users/{public_identifier}?account_id=X    LinkedIn profile lookup
POST /api/v1/users/invite?account_id=X        connection request
GET  /api/v1/chats?account_id=X
POST /api/v1/chats?account_id=X               start chat / send message
GET  /api/v1/emails?account_id=X
POST /api/v1/emails?account_id=X              send email
```

### What does NOT exist on v1 (and is gated on v2)

- Recruiter pipeline candidates (`/linkedin/recruiter/projects/{id}/pipeline`) — exists in v2 spec, 403 from our v2 app
- Save candidate to Recruiter pipeline (`/linkedin/recruiter/projects/{id}/pipeline/candidate/save`) — same
- Create Recruiter project programmatically — same
- Proxy country override (`PATCH /v2/{acct}/proxy`) — v2-only; throws as non-fatal warning today

These actions return 501 from our API with a comment pointing to the Phase 2 v2 unblock. Don't try to re-implement them on v1; the routes don't exist.

### Phase 2 — flipping to v2 (future)

When Unipile unblocks v2 Recruiter scope on app `app_01kr071epafvjsg64xdb2edgfz`:
1. Swap the URL builders in `unipile-urls.ts` to use `${v2Base}/${metadata.unipile_account_id_v2}/<path>` (path segment, not query param)
2. Swap the API key to `UNIPILE_API_KEY_V2`
3. The DB already has the `acc_xxx` IDs in `metadata.unipile_account_id_v2` — no re-connection needed

