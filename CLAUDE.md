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
- **People↔companies auto-link (2026-06-12):** `people.company_id` is resolved automatically from company text (`company_name` → `current_company` → `linkedin_current_company`) by `find_company_id_by_name()`, which normalizes via `normalize_company_name()` and checks `companies.name` first, then the `company_aliases` table. Triggers keep it current: people insert/company-text change, companies insert/rename, and company_aliases insert all (re)claim links. **Never list a company's people by text-matching `company_name` — filter on `company_id`.** To map a name variant to an existing company ("Millennium" → Millennium Management), insert a `company_aliases` row — its trigger links matching unlinked people immediately.
- Person statuses (shared candidate + client): `new`, `reached_out`, `engaged` — nothing else (CHECK constraint enforces this)
- Pipeline stage tables: `pitches`, `send_outs`, `submissions`, `interviews`, `placements`, `rejections`
- Ashley has email and LinkedIn but NO RingCentral — no SMS routing for Ashley

## Unipile API — v1 (methods) + v2 (lifecycle **and** Recruiter writes) — updated June 7 2026

Unipile has now shipped the full **v2 Methods API** (LinkedIn, Recruiter, messaging, email, calendar). We are migrating **incrementally**. **Today: LinkedIn Recruiter project-create + pipeline-save run on v2 (flag-gated, flag is ON); everything else still runs on v1.** Centralized helpers:
- `frontend/api/lib/unipile-urls.ts` — v1 builders (`linkedinV1`) + v2 templates (`recruiterV2`)
- `frontend/src/server-lib/unipile-v2.ts` — `unipileFetch()` = **v1**, `unipileFetchV2()` = **v2**, `isLinkedinV2Enabled()`, `getUnipileAccountV2IdByV1Id()`

| Concern | API | Host | Key | account_id |
|---|---|---|---|---|
| Most methods — messaging, email, calendar, search, jobs, project/applicant **reads**, contracts | **v1** | tenant DSN `api19.unipile.com:14926/api/v1` | `UNIPILE_API_KEY` | **query param** `?account_id=<short_id>` |
| Recruiter **writes** — create project, save candidate to pipeline | **v2** | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | **path segment** `/v2/<acc_xxx>/...` |
| Lifecycle — hosted auth, checkpoint, webhooks, accounts | v2 | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | — |

### v2 Recruiter migration status (verified live June 7 2026)

- ✅ **The old `403 "Insufficient permissions"` is RESOLVED.** App `app_01kr071epafvjsg64xdb2edgfz` now has v2 Recruiter scope — confirmed live: `GET /v2/<acc_xxx>/linkedin/recruiter/projects` → **200** with a real hiring project. Chris's LinkedIn account reports `products_connection_status.recruiter = running`.
- ✅ Migration `20260606000000_add_unipile_account_id_v2.sql` added the **`integration_accounts.unipile_account_id_v2`** column (canonical `acc_xxx`) + seeded the `UNIPILE_LINKEDIN_V2` flag in `app_settings`.
- ✅ `UNIPILE_LINKEDIN_V2 = true` (ENABLED). `source-projects.ts` `create_project`/`save_candidate` call `unipileFetchV2`; all read actions stay on v1.
- ✅ `acc_xxx` backfilled: Chris `acc_01ktfd159mfk1bj8vc6a1g2jxb`, Ashley `acc_01kr0nd2qgend81n5tekmksrsx`. **Nancy's LinkedIn is NOT on the v2 app (only her Outlook is) — needs a reconnect to source on v2.**
- ⚠️ **create/save v2 POST body shapes are NOT confirmed yet.** A `{name, visibility}` create body returns `400 api/invalid_parameters`. Pull the real schema from Unipile's Recruiter API reference and fix the `recruiterV2` request bodies in `source-projects.ts` before relying on writes.
- ⚠️ **acc_xxx storage inconsistency to reconcile:** `unipile-v2.ts` reads the **top-level column** `unipile_account_id_v2`; `connect-linkedin*.ts` reads **`metadata.unipile_account_id_v2`**. Standardize on the column (or write both on connect).

### Key gotchas (still true)

- v1 uses the **short** id (`1Ti3bx-8RrC0B91qxp_9ww`); v2 uses **`acc_xxx`**. Same account, different id per API. v1 returns 404 for `acc_xxx`; v2 returns 404 for short ids. `getUnipileAccountV2IdByV1Id()` maps short → `acc_xxx`.
- **Do NOT swap keys.** `UNIPILE_API_KEY` (v1) 401s on the v2 host; `UNIPILE_API_KEY_V2` 401s on the v1 DSN. They're scoped to different Unipile apps.
- `api.unipile.com/v2/docs/json` is the **lifecycle-only** OpenAPI (~8 endpoints: accounts/auth/webhooks). The **Methods** reference lives on `developer.unipile.com` (it bot-blocks WebFetch → 403; fetch it server-side via Supabase `pg_net`, or read the Node SDK).

### Confirmed v1 routes (still in use for everything except Recruiter writes)

```
GET  /api/v1/accounts                         list connected accounts
GET  /api/v1/accounts/{short_id}              account detail
GET  /api/v1/linkedin/projects?account_id=X   Recruiter hiring projects (LIST/read)
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

### v2 Recruiter routes (path segment + `UNIPILE_API_KEY_V2`)

```
GET  /v2/{acc_xxx}/linkedin/recruiter/projects                         ✅ confirmed 200
POST /v2/{acc_xxx}/linkedin/recruiter/projects                         ⚠️ body shape TBD (400 on {name,visibility})
POST /v2/{acc_xxx}/linkedin/recruiter/projects/{id}/pipeline/candidate/save   ⚠️ body shape TBD
GET  /v2/{acc_xxx}/linkedin/recruiter/inmail-credits
POST /v2/{acc_xxx}/linkedin/recruiter/search/people
```

### Still on v1, NOT yet migrated (v2 equivalents exist per Unipile's v2 Methods matrix, just not wired)

Messaging + InMail, email send/receive, calendar, people/company search, job applicants, profile lookups. Migrate these the same way Recruiter writes were: add v2 templates to `unipile-urls.ts`, route through `unipileFetchV2`, gate behind a flag, verify the body shape against the v2 reference before flipping on.
