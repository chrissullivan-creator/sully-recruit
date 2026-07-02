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

## MCP Server — `/api/mcp` (external read/write surface, added 2026-06-21)

`frontend/api/mcp.ts` is a Model Context Protocol server (**Vercel function**, not a Supabase edge fn — it ships on the normal push to `main`) that exposes the CRM as tools for ChatGPT (Developer Mode), Claude, Claude Code, or Joe.

- **Transport:** one POST endpoint, JSON-RPC 2.0 over Streamable HTTP; `reply()` returns SSE when the request `Accept` includes `text/event-stream` (ChatGPT) else JSON (Claude Code). Stateless (no session id).
- **URLs:** `https://app.sullyrecruit.com/api/mcp` or `https://sullyrecruit.app/api/mcp` (both custom domains route to the Vercel project even though `get_project` only lists the `*.vercel.app` aliases). Add in ChatGPT via **Developer Mode** (desktop web, paid plan) — NOT the Deep-Research/Apps search-fetch flow. "Failed to add connector link" is usually a stuck entry → delete + recreate.
- **Per-user auth:** `public.mcp_tokens` maps `sha256(token)` → `user_id` (+label), so writes are attributed to the real recruiter (Chris/Nancy/Ashley). Each person pastes their own token (API-key auth) in their ChatGPT. **Discovery (`initialize`/`tools/list`/`ping`) is unauthenticated on purpose** — ChatGPT lists tools before sending the key, so gating discovery 401s the connector; only `tools/call` is token-gated. Shared `MCP_AUTH_TOKEN` env → default actor (Chris) for the Claude Code/admin path. Raw tokens are NEVER committed — only the hash lives in the DB.
- **Tools (25 total):** reads (9) `search`, `get_person`, `get_job`, `get_company`, `pipeline_report`, `last_touch`, `list_jobs`, `describe_schema`, `query`; writes (16) `add_person`, `update_person`, `set_do_not_contact`, `add_note`, `tag_person_to_job`, `set_pipeline_stage`, `list_sequences`, `create_sequence`, `enroll_people`, `set_enrollment_status`, `add_company`, `update_company`, `add_job`, `update_job`, `add_job_contact`, `link_person_to_company`. Writes honor the app invariants (status enum, pipeline ladder, `classifyEmail`, `do_not_contact`, `find_company_id_by_name` auto-link, the `sequence/enrollment-init.requested` engine event). **ChatGPT caches `tools/list` at connect time — after a new tool ships you must refresh/reconnect the connector or it won't appear (this is the usual cause of "MCP can't create jobs/companies": the connector is showing an old 17/19-tool snapshot).**
- **`query` = read-only SQL, ON by default** (`MCP_ENABLE_RAW_SQL=false` to disable) via `mcp_run_read_query()` (SECURITY DEFINER, forced read-only, ≤1000 rows / 8s, `service_role`-only — not an RLS bypass).
- **Gotchas:** new tools need a connector refresh in ChatGPT to appear; you can't curl the domains from the Claude Code sandbox (egress allowlist) → test live with Supabase `pg_net`; `git reset --hard origin/main` before each new change since the dev branch diverges after a squash-merge. Full detail in SKILL-architecture.md.

## Skills

Read these before making changes:

- `claude/SKILL-architecture.md` — DB schema, API patterns, secrets, common mistakes
- `claude/SKILL-frontend.md` — React components, routing, UI patterns
- `claude/SKILL-webhooks.md` — Webhook handlers, Unipile/Microsoft/RingCentral
- `claude/SKILL-sequences.md` — Sequence engine, enrollment logic
- `claude/SKILL-joe.md` — AI assistant (Joe) behavior
- `claude/SKILL-calls.md` — RingCentral call handling

## Key Rules

- AI cascade lives in `frontend/src/lib/ai-fallback.ts:callAIWithFallback`. Default order is now **Claude → OpenAI → Gemini** (`DEFAULT_ORDER`); **`RESUME_PARSE_ORDER` = OpenAI → Claude → Gemini**. **OpenRouter was dropped from both default orders 2026-06-26** (`360dac0` — dead/unfunded account); the `"openrouter"` provider + `tryOpenRouter` still exist and callers may still pass `openRouterKey`, so re-add it to the two order constants if the account is ever funded. Orders overridable per call via `order`. Resume-parse order applies in `parse-resume-ai.ts`, `resume-ingestion.ts`, `reparse-resumes.ts`, `reconcile-orphaned-resumes.ts`; `parse-resume.ts` is self-contained (its own inlined cascade). **`gpt-5.4` is now opt-in per call via `fallbackModel`** for the in-app résumé formatter (`format-resume-ai.ts`) and the BD-sequence generator (`jobs/[id]/create-bd-sequence.ts`); `ai-fallback` sends `max_completion_tokens` (not `max_tokens`) and omits `temperature` for `gpt-5*`/`o*` reasoning models, and cascades on `404 / model_not_found / unsupported_param`. Default OpenAI model is still `gpt-4o-mini`. No Eden AI, no Lovable gateway. **NB: `ask-joe` has its own separate self-contained cascade (OpenAI → Claude → Gemini → OpenRouter) and still keeps OpenRouter — it was not touched by `360dac0`.**
- Unipile API key comes from `app_settings` table via `getAppSetting("UNIPILE_API_KEY")` — NOT from `integration_accounts.access_token`
- Edge function secrets: `ANTHROPIC_API_KEY` (check lowercase fallback `anthropic_api_key`)
- Frontend env vars must be `VITE_*` prefixed
- **Unified person model:** `people` is the base table for BOTH candidates and clients via `roles` / `type` (`'candidate'` | `'client'`). `candidates` and `contacts` are backwards-compat views over `people`; new code should prefer `from('people')` unless it is deliberately using an older view contract.
- **People↔companies auto-link (2026-06-12):** `people.company_id` is resolved automatically from company text (`company_name` → `current_company` → `linkedin_current_company`) by `find_company_id_by_name()`, which normalizes via `normalize_company_name()` and checks `companies.name` first, then the `company_aliases` table. Triggers keep it current: people insert/company-text change, companies insert/rename, and company_aliases insert all (re)claim links. **Never list a company's people by text-matching `company_name` — filter on `company_id`.** To map a name variant to an existing company ("Millennium" → Millennium Management), insert a `company_aliases` row — its trigger links matching unlinked people immediately.
- Person statuses (shared candidate + client): `new`, `reached_out`, `engaged` — nothing else (CHECK constraint enforces this)
- Pipeline stage tables: `pitches`, `send_outs`, `submissions`, `interviews`, `placements`, `rejections`
- **Custom fields (2026-06-14):** admin-defined fields via `custom_field_defs` + a `custom_fields JSONB` column (pilot: `people` only). UI at Settings → Custom Fields; editor in CandidateDetail Background tab (candidates only so far). Cast `from('custom_field_defs' as any)` — not in generated types. See SKILL-architecture.md / SKILL-frontend.md.
- **Data Hygiene (2026-06-14):** Duplicates (`/duplicates`) + Collisions (`/admin/collisions`) moved from the sidebar to Settings → Data Hygiene; routes still registered for deep links.
- Ashley has email and LinkedIn but NO RingCentral — no SMS routing for Ashley
- **Proactive & Agentic Joe (2026-06-21):** Joe is now an operating layer, not just chat. Two flags in `app_settings` (read server-side): **`JOE_PROACTIVE_ENABLED`** (ON) gates the daily-briefing cron + per-person `next_action`; **`JOE_AGENTIC_ENABLED`** (OFF) gates the `ask-joe` propose-only write tools. Tables: **`joe_briefings`** (per-recruiter "Today" feed, owner-RLS), **`joe_action_queue`** (agent inbox), plus **`people.next_action`**. **`ask-joe` is now OpenAI-first** (`OpenAI → Claude → Gemini → OpenRouter`); the proactive surfaces (`joe-daily-brief.ts`, `generate-joe-says` next_action) pass `RESUME_PARSE_ORDER` (OpenAI-first) too. Frontend: `/today` page (`Today.tsx`) + sidebar nav; `JoeActionCard` renders approve/edit/reject proposals in Ask Joe. Write tools NEVER write server-side — they emit a `data: {"action":{…}}` SSE event; the client executes only on approval, and `do_not_contact` blocks outreach proposals. **Editing `ask-joe` requires `supabase functions deploy ask-joe`** (not shipped by the Vercel push). See SKILL-joe.md / SKILL-architecture.md / SKILL-frontend.md.
- **External MCP server (2026-06-21):** `frontend/api/mcp.ts` (`/api/mcp`, a Vercel fn) exposes the CRM over MCP — read **and** write — for ChatGPT (Developer Mode), Claude, and Claude Code. Per-user tokens in `mcp_tokens` (sha256→user) attribute writes; **discovery is unauthenticated, `tools/call` is token-gated**; `query` runs read-only SQL via `mcp_run_read_query()` (ON by default). Ships on the normal `main` push. **NB: `jobs.status` is actually `lead|hot|closed_lost`** (the old `open/closed` was never real). See the "MCP Server — `/api/mcp`" section above + SKILL-architecture.md.

### Shipped week of 2026-06-27

- **Visual refresh — LIGHT theme now (2026-06-26):** the app flipped from dark to a **white-canvas / white-sidebar** premium look. Tokens in `frontend/src/index.css` (`:root`): `--primary` = emerald `#0B4F2F`, `--accent` = gold `#C9A227`, neutrals retinted to a low-sat **sage** family (hue ~146–150°), cards/popovers stay pure white, `--radius` 14px. Brand mark = lucide **`Martini`** icon (replaced `Sparkles` everywhere, #380). Recruiter photos via `lib/recruiterAvatars.ts`; `PersonAvatar` + `CompanyLogo` (Clearbit fallback) rolled out site-wide. See SKILL-frontend.md.
- **Dashboard AI Command Center (2026-06-26):** `components/dashboard/CommandCenter.tsx` (hero on `Index.tsx`) — KPI strip + AI "signal" cards (Ready to Move, Follow-ups Due, Below Market, Searches at Risk, Ask-Joe-says, Revenue), one round-trip via the `command_center_summary()` RPC (`useCommandCenter.ts`).
- **Jobs split into two boards (2026-06-26):** `Jobs.tsx` — **Leads board** (status=`lead`, draggable on `jobs.lead_stage` from `LEAD_STAGES`) + **Hot Jobs board** (non-lead, read-only, each job sits in the column of its furthest-along candidate via `useJobPipelineStages()`). Generic `components/pipeline/JobStageBoard.tsx`.
- **Interviews / Planner (2026-06-25):** new `/interviews` page under Planner (`Calendar | To-Do's | Interviews`). `interviews` stage table now drives a real UI; **multiple rounds = one row per round** (`interviews.round`, `lib/createInterview.ts` auto-increments). Auto-created when a send-out hits an interview stage (`lib/interviewWorkflow.ts`). **CHECK constraints (fixed #606da):** `interview_type ∈ {phone_screen,video,onsite,technical,case_study,partner,final}`, `outcome ∈ {passed,rejected,no_show,cancelled,pending}`, `stage ∈ {to_be_scheduled,scheduled,interview_debrief}`. New: `interview_interviewers` junction, `interviews.calendar_event_ids jsonb`, non-blocking calendar drop to owner **+ always Chris** (`/api/interview-calendar-sync`). See SKILL-architecture.md / SKILL-frontend.md.
- **Send Out → Submission flow (2026-06-27):** full in-app guided flow `pages/SendOut.tsx` (`/candidates/:id/sendout`, steps choose→formatting→preview→email). **In-app server-side résumé formatter** `/api/format-resume-ai.ts` (Emerald-house HTML, `gpt-5.4`) → PDF client-side (`html2canvas`+`jsPDF`) → Tiptap email composer → send-now or schedule (`/api/send-sendout` → `scheduled_messages` + Inngest `send-message-scheduled`). New `send_outs` cols + `OfferDialog`. This is the in-app sibling of the ChatGPT path in `claude/GPT-SENDOUT-ACTION.md`.
- **Debrief call → interview (2026-06-25):** a recorded RingCentral call can attach to an interview — `call_logs.interview_id` / `ai_call_notes.interview_id`; the Deepgram runner **skips candidate-field backfill when `interview_id` is set**. See SKILL-calls.md.
- **Ask Joe everywhere + new read tools (2026-06-26/27):** global launcher `components/joe/AskJoeLauncher.tsx` on every page (⌘/Ctrl-J). Joe now has **11 read tools** (added `list_company_people` + `search_messages`); `enroll_in_sequence` is an agentic (`JOE_AGENTIC_ENABLED`) propose-only write tool that resolves people by name/email. Editing `ask-joe` still requires `supabase functions deploy ask-joe`. See SKILL-joe.md.
- **Inbox / Comm Hub overhaul (2026-06-26/27):** new **"All"** tab is the default (unions focused + unlinked + live unknown-sender threads); `inbox_threads` view exposes `sender_name`/`avatar_url`; `ThreadAvatar`. **Inbox Add** does fuzzy match → update-or-create (`/api/search-person`, `/api/update-person`, shared `api/lib/fuzzy-match-person.ts`) + bulk **Reconcile** (`/api/inbox/reconcile-unknown`, link-only). **All `linkedin.com` emails are now noise** (`server-lib/marketing-blocklist.ts`). See SKILL-frontend.md / SKILL-webhooks.md.
- **Import from LinkedIn Recruiter (2026-06-24/27):** `/admin/linkedin-recruiter-import` — paste a Recruiter search/pipeline URL → v2 `recruiter/search` (read-only) → preview → fuzzy-dedup review (`/api/match-people` + `ImportMatchReviewDialog`) → CSV or import (`/api/add-person`, new `merge_into` mode).
- **Picklist multi-selects (2026-06-25, #370):** new `picklist_options` table + `text[]` columns — `people.departments`/`products`, `jobs.departments`/`products`, `companies.industries`/`strategies`. `PicklistMultiSelect` + Settings → Option Lists. (Company Strategy shows only for Hedge Funds.)
- **Soft-delete cascade + funnel fix (2026-06-25):** deleting a person sets `people.deleted_at` and **cascade-soft-deletes** its send_outs/candidate_jobs + stops enrollments (undoable — restore reverses it). Reads must filter `deleted_at IS NULL`. `candidate_jobs.max_pipeline_stage` ratchet triggers fix funnel double-counting.
- **Dedup fuzzy pass (2026-06-27, #378):** `/api/dedup/scan.ts` adds a Sørensen–Dice **name+firm+title** pass (blocked by last name, `match_type:"name"`, capped below exact). Shared scorer `api/lib/fuzzy-match-person.ts`.
- **reply_sentiment widened (2026-06-25):** the `reply_sentiment` CHECK now allows 9 values — `positive, interested, neutral, negative, not_interested, maybe, do_not_contact, ooo, booked_meeting`; `intel-extraction.ts` clamps off-vocab sentiment to `neutral` (`safeSentiment`).
- **Client workflow + sequence safeguards (2026-07-02, #400):** Contacts-facing UI is now labeled **Clients**. `Contacts.tsx` matches the Candidates list tone, shows sortable **Last Reached Out** / **Last Responded**, and treats OOO/bounce/returned delivery signals as non-answers. `ContactDetail.tsx` supports `?edit=1`, adds a **Background** tab with editable relationship/client notes plus work history and education, and shows company/job-linked interviews with debrief access. Microsoft/Unipile email handlers only stamp `last_responded_at` after OOO detection; OOO auto-replies reschedule but do not count as human answers. `email_invalid` recipients stop sequence work at init/send time, BD sequence contact IDs are deduped, and migration `20260702024451_prevent_duplicate_sequence_work.sql` enforces one live enrollment per person/sequence plus one open step log per enrollment/action.

## Unipile API — v1 (reads/email/calendar) + v2 (lifecycle, Recruiter writes, **LinkedIn message sends**) — updated June 27 2026

Unipile has now shipped the full **v2 Methods API** (LinkedIn, Recruiter, messaging, email, calendar). We are migrating **incrementally**. **Today on v2: (1) LinkedIn message _sends_ — classic DM / InMail / connection requests — via `frontend/src/server-lib/send-channels.ts`, and (2) Recruiter _search-from-URL_ (the Import feature). Both send flags (`UNIPILE_LINKEDIN_V2`, `USE_LINKEDIN_V2_SEND`) are ON; the v2 send path is taken whenever the account has an `acc_xxx` id (else it falls back to v1). Recruiter project-create / pipeline-save do NOT exist in the API (501 — see migration status below). Everything else (email send/receive, calendar, search, jobs, project/applicant reads, contracts, LinkedIn message reads) still runs on v1.** Centralized helpers:
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
POST /api/v1/users/invite?account_id=X        connection request  (v1 FALLBACK only — v2 uses users/me/relation-requests)
GET  /api/v1/chats?account_id=X
POST /api/v1/chats?account_id=X               send message  (v1 FALLBACK only — v2 uses chats/send + specifics; see v2 SEND routes below)
GET  /api/v1/emails?account_id=X
POST /api/v1/emails?account_id=X              send email
```

### v2 LinkedIn SEND routes (live — `send-channels.ts`, finalized June 24 2026)

These are the **actual live send shapes** in `sendLinkedInV2()` (`linkedinV2SendPaths`). They **replaced** the old v1 `POST /chats` + `POST /users/invite` shapes — those 404/501 on v2. Recipient key is **`users_ids`** (not `attendees_ids`), body key is **`specifics`** (not `options`):

```
POST /v2/{acc_xxx}/users/me/relation-requests        connection request
     body: { user_id: providerId, message?: note }   ← key is user_id, note key is message
POST /v2/{acc_xxx}/inboxes/RECRUITER_PRIMARY/chats/send   Recruiter InMail
     body: { text, users_ids:[providerId], specifics:{ linkedin:{ recruiter:{ subject, signature } } } }
     ↑ subject + signature BOTH required (signature = sender profiles.display_name)
     ↑ top-level chats/send 501s for recruiter — InMail MUST use the inbox-scoped route
POST /v2/{acc_xxx}/chats/send                          classic DM
     body: { text, users_ids:[providerId], specifics:{ linkedin:{ classic:{} } } }
```
> The `USE_LINKEDIN_INBOX_API` flag + `sendViaInboxEndpoint()` are dead/disabled — leave OFF.

### v2 Recruiter routes (path segment + `UNIPILE_API_KEY_V2`)

```
GET  /v2/{acc_xxx}/linkedin/recruiter/projects                         ✅ confirmed 200 (read)
GET  /v2/{acc_xxx}/linkedin/recruiter/inmail-credits
POST /v2/{acc_xxx}/linkedin/recruiter/search/people
POST /v2/{acc_xxx}/linkedin/recruiter/search                           ✅ "search from URL" (Import from LinkedIn Recruiter, #369)
```
> project-create / pipeline-save do NOT exist in the API (501, see migration status above).

### Still on v1, NOT yet migrated (v2 equivalents exist per Unipile's v2 Methods matrix, just not wired)

Email send/receive (via Microsoft Graph — `USE_UNIPILE_EMAIL` is OFF), calendar, people/company search, job applicants, profile lookups, and LinkedIn message **reads**/backfill. **LinkedIn message _sends_ (classic DM / InMail / connection requests) are already on v2** via `send-channels.ts` — the classic-DM v2 shape is proven by live traffic (157 sends in the 30d to 2026-06-19); InMail is less battle-tested. Migrate the remaining reads the same way Recruiter writes were: add v2 templates to `unipile-urls.ts`, route through `unipileFetchV2`, gate behind a flag, verify the body shape against the v2 reference before flipping on.
