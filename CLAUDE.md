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
- **Custom fields (2026-06-14):** admin-defined fields via `custom_field_defs` + a `custom_fields JSONB` column (pilot: `people` only). UI at Settings → Custom Fields; editor in CandidateDetail Background tab (candidates only so far). Cast `from('custom_field_defs' as any)` — not in generated types. See SKILL-architecture.md / SKILL-frontend.md.
- **Data Hygiene (2026-06-14):** Duplicates (`/duplicates`) + Collisions (`/admin/collisions`) moved from the sidebar to Settings → Data Hygiene; routes still registered for deep links.
- Ashley has email and LinkedIn but NO RingCentral — no SMS routing for Ashley
- **Proactive & Agentic Joe (2026-06-21):** Joe is now an operating layer, not just chat. Two flags in `app_settings` (read server-side): **`JOE_PROACTIVE_ENABLED`** (ON) gates the daily-briefing cron + per-person `next_action`; **`JOE_AGENTIC_ENABLED`** (OFF) gates the `ask-joe` propose-only write tools. Tables: **`joe_briefings`** (per-recruiter "Today" feed, owner-RLS), **`joe_action_queue`** (agent inbox), plus **`people.next_action`**. **`ask-joe` is now OpenAI-first** (`OpenAI → Claude → Gemini → OpenRouter`); the proactive surfaces (`joe-daily-brief.ts`, `generate-joe-says` next_action) pass `RESUME_PARSE_ORDER` (OpenAI-first) too. Frontend: `/today` page (`Today.tsx`) + sidebar nav; `JoeActionCard` renders approve/edit/reject proposals in Ask Joe. Write tools NEVER write server-side — they emit a `data: {"action":{…}}` SSE event; the client executes only on approval, and `do_not_contact` blocks outreach proposals. **Editing `ask-joe` requires `supabase functions deploy ask-joe`** (not shipped by the Vercel push). See SKILL-joe.md / SKILL-architecture.md / SKILL-frontend.md.

## Unipile API — v1 (reads/email/calendar) + v2 (lifecycle, Recruiter writes, **LinkedIn message sends**) — updated June 20 2026

Unipile has now shipped the full **v2 Methods API** (LinkedIn, Recruiter, messaging, email, calendar). We are migrating **incrementally**. **Today on v2: (1) LinkedIn Recruiter project-create + pipeline-save, and (2) LinkedIn message _sends_ — classic DM / InMail / connection requests — via `frontend/src/server-lib/send-channels.ts`. Both flags (`UNIPILE_LINKEDIN_V2`, `USE_LINKEDIN_V2_SEND`) are ON; the v2 send path is taken whenever the account has an `acc_xxx` id (else it falls back to v1). Everything else (email send/receive, calendar, search, jobs, project/applicant reads, contracts, LinkedIn message reads) still runs on v1.** Centralized helpers:
- `frontend/api/lib/unipile-urls.ts` — v1 builders (`linkedinV1`) + v2 templates (`recruiterV2`)
- `frontend/src/server-lib/unipile-v2.ts` — `unipileFetch()` = **v1**, `unipileFetchV2()` = **v2**, `isLinkedinV2Enabled()`, `getUnipileAccountV2IdByV1Id()`

| Concern | API | Host | Key | account_id |
|---|---|---|---|---|
| Most methods — email, calendar, search, jobs, project/applicant **reads**, contracts, LinkedIn message **reads** | **v1** | tenant DSN `api19.unipile.com:14926/api/v1` | `UNIPILE_API_KEY` | **query param** `?account_id=<short_id>` |
| Recruiter **writes** — create project, save candidate to pipeline | **v2** | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | **path segment** `/v2/<acc_xxx>/...` |
| LinkedIn message **sends** — classic DM / InMail / connection requests (via `send-channels.ts`, `USE_LINKEDIN_V2_SEND` ON) | **v2** | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | **path segment** `/v2/<acc_xxx>/...` |
| Lifecycle — hosted auth, checkpoint, webhooks, accounts | v2 | `api.unipile.com/v2` | `UNIPILE_API_KEY_V2` | — |

### v2 Recruiter migration status (verified live June 7 2026)

- ✅ **The old `403 "Insufficient permissions"` is RESOLVED.** App `app_01kr071epafvjsg64xdb2edgfz` now has v2 Recruiter scope — confirmed live: `GET /v2/<acc_xxx>/linkedin/recruiter/projects` → **200** with a real hiring project. Chris's LinkedIn account reports `products_connection_status.recruiter = running`.
- ✅ Migration `20260606000000_add_unipile_account_id_v2.sql` added the **`integration_accounts.unipile_account_id_v2`** column (canonical `acc_xxx`) + seeded the `UNIPILE_LINKEDIN_V2` flag in `app_settings`.
- ✅ `UNIPILE_LINKEDIN_V2 = true` (ENABLED). `source-projects.ts` `create_project`/`save_candidate` call `unipileFetchV2`; all read actions stay on v1.
- ✅ `acc_xxx` backfilled: Chris `acc_01ktfd159mfk1bj8vc6a1g2jxb`, Ashley `acc_01kr0nd2qgend81n5tekmksrsx`, Nancy `acc_01kr1tkcx3e05a91agneahjafh`. **But Nancy's v1 LinkedIn id `ZsitoJXDQ8iSD6xGfpwj1A` now 404s "Account not found" on the DSN — and project reads run on v1, so her LinkedIn needs a reconnect before Source lists her projects.**
- ❌ **There is NO programmatic create-project / save-candidate-to-pipeline in Unipile — stop chasing a v2 body shape.** Verified June 12 2026 against `unipile-node-sdk@1.9.3` + the public reference: hiring projects are **read-only** via the API. The SDK has a `LinkedinHiringProject` *read* schema and lets you tag a Recruiter InMail with `hiring_project_id` (`chat-start` → `linkedin[hiring_project_id]`), but exposes **no** project-create and **no** pipeline-save endpoint; the docs only have "create *job posting*" (a different object). The `{name, visibility}` 400 wasn't a wrong body — the endpoint doesn't exist. `source-projects.ts` `create_project`/`save_candidate` now return an honest 501 (they were never wired to any UI). Workflow: create projects in LinkedIn Recruiter (they sync via the v1 `list_projects` read); add a candidate to a project by sending a Recruiter InMail tagged with its `hiring_project_id`.
- ✅ **acc_xxx storage inconsistency RESOLVED (#309).** Migration `20260612000000_backfill_unipile_account_id_v2.sql` copies `metadata->>'unipile_account_id_v2'` → the top-level `unipile_account_id_v2` column, and `getUnipileAccountV2IdByV1Id()` / `getUnipileAccountV2IdForUser()` now coalesce column→metadata so metadata-only rows still resolve.

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

Email send/receive (via Microsoft Graph — `USE_UNIPILE_EMAIL` is OFF), calendar, people/company search, job applicants, profile lookups, and LinkedIn message **reads**/backfill. **LinkedIn message _sends_ (classic DM / InMail / connection requests) are already on v2** via `send-channels.ts` — the classic-DM v2 shape is proven by live traffic (157 sends in the 30d to 2026-06-19); InMail is less battle-tested. Migrate the remaining reads the same way Recruiter writes were: add v2 templates to `unipile-urls.ts`, route through `unipileFetchV2`, gate behind a flag, verify the body shape against the v2 reference before flipping on.
