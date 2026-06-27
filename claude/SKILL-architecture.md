# Sully Recruit — Architecture Skill

## STOP. Read this before writing a single line of code or SQL.

This skill captures hard-won knowledge about the Sully Recruit codebase. Every item here represents a real bug we hit. Don't repeat them.

---

## What changed on 2026-05-07 — read this first

If you're returning to this codebase, these are the recent invariants that bite:

- **`people.email` is gone.** Use `personal_email`, `work_email`, or the generated `primary_email` (`COALESCE(personal_email, work_email)` — personal-first since the sequence flip). Legacy reads through the `candidates` / `contacts` views still see an `email` column — it's computed, not real. Writes that hand `email:` straight to `from('people').insert({...})` will error. New writers: spread `classifyEmail(addr)` into the payload (helper exported from `frontend/src/lib/email-classifier.ts` + `frontend/src/trigger/lib/match-person-by-email.ts`) so consumer-domain addresses go to `personal_email` and corporate to `work_email`. There's also `secondary_emails TEXT[]` to capture extra/import-residue addresses without losing them.
- **Dual roles.** `people.roles TEXT[]` (e.g. `['candidate']`, `['client']`, or both). `people.type` is kept in sync via a BEFORE-trigger; treat `roles` as the truth, `type` as the primary-display label. `/api/add-person` auto-merges: if the submitted email matches an existing person, the new role is appended instead of duplicating the row.
- **Inbound email matching is multi-column.** `trigger/lib/match-person-by-email.ts:matchPersonByEmail` ORs across all three address columns. Every webhook + backfill route through it. Don't `.eq("email", x)` on `people` directly — it can't.
- **Unipile API split (canonical: `CLAUDE.md`, updated 2026-06).** Most methods (messaging, email, calendar, project/applicant reads) are **v1** — tenant DSN, `account_id` as a **query param**, `UNIPILE_API_KEY` — via `frontend/src/server-lib/unipile-v2.ts:unipileFetch(supabase, accountId, path, init)`. **LinkedIn Recruiter writes** (create project, save candidate) are **v2** — `api.unipile.com/v2`, `account_id` as a **path segment** (`acc_xxx`), `UNIPILE_API_KEY_V2` — via `unipileFetchV2()`, gated by `UNIPILE_LINKEDIN_V2` (ON). The old `trigger/lib/` path is now `frontend/src/server-lib/`. Send-channels uses `{ attendees_ids:[providerId], text, linkedin: { api: 'recruiter' } }` for InMail, not `message_type: "INMAIL"`.
- **Channel buckets are FOUR, not five.** `email`, `sms`, `linkedin`, `linkedin_recruiter`. Sales Navigator was removed from the active code paths — `canonicalChannel()` now folds any sales_navigator label into `linkedin`. Inbound bucketing reads `chat.content_type === 'inmail'` or `folder` includes `'INBOX_LINKEDIN_RECRUITER'`. Don't fall back to integration_account.account_type alone.
- **InMail credit guard.** `sync-inmail-credits` cron stamps `integration_accounts.inmail_credits_remaining`. `sendLinkedIn` refuses to fire an InMail when the cached balance is 0; successful InMails decrement the cache locally between hourly polls.
- **Custom fields layer (2026-06-14).** Admin-defined fields without a migration. Definitions in `custom_field_defs` (`entity_type` ∈ candidate|client|company|job, immutable `key`, `label`, `field_type`, `options`, `section`, `display_order`, `required`, `is_active`); values in a `custom_fields JSONB` column on the base table — **pilot: `people` only** (companies/jobs add their own column on rollout). `useCandidate` reads `people.*` so values come along free — **no view recreation**. Validation is UI-side (no DB trigger — `people` has too many writers); `required` is a UI hint only; `key` is immutable. `custom_field_defs` isn't in generated types → cast `from('custom_field_defs' as any)`. Admin UI: Settings → Custom Fields; record editor: `CustomFieldsSection` in CandidateDetail's Background tab (candidates only so far). See SKILL-frontend.md.
- **People↔companies auto-link (2026-06-12).** `people.company_id` is set automatically — never text-match `company_name`/`current_company` to list a company's people; filter on `company_id` (CompanyDetail does this now, Contacts + Candidates tabs). Resolution: `find_company_id_by_name(text)` normalizes via `normalize_company_name()` (lowercase, strip leading "the" + trailing inc/llc/lp/ltd/etc, drop non-alphanumerics) and checks `companies.name` first, then `company_aliases.alias_normalized`. Auto-link triggers: `trg_auto_link_person_company` (people insert / company-text change; respects an explicitly-set company_id), `trg_claim_people_for_company` (companies insert/rename claims unlinked matching people), `trg_claim_people_for_company_alias` (alias insert claims immediately). ~100 curated aliases exist ("Millennium"→Millennium Management, "JPMorgan Chase & Co."→J.P. Morgan, "SS&C GlobeOp"→SS&C Technologies...). Deliberately separate firms — do NOT alias-merge: Citadel vs Citadel Securities, Citi vs Citizens Bank, Point72 vs Cubist Systematic Strategies, GTS vs GTSF. To tie a new variant: `INSERT INTO company_aliases (company_id, alias) VALUES (...)` and the trigger backfills.
- **Proactive & Agentic Joe (2026-06-21).** Joe became an operating layer. New tables: **`joe_briefings`** (per-recruiter "Today" feed — `owner_user_id`, `entity_type` candidate|client|job, `category` hot_lead|going_cold|stalled|reply_waiting|ops_warning, `headline`, `rationale`, `score`, `status`, owner-RLS) and **`joe_action_queue`** (agent inbox, owner-RLS); new column **`people.next_action`** (+ `next_action_updated_at`). Neither table is in generated types → cast `from('joe_briefings' as any)` / `from('joe_action_queue' as any)`. Two `app_settings` flags read server-side: **`JOE_PROACTIVE_ENABLED`** (ON — gates `joe-daily-brief.ts` cron + `generate-joe-says` next_action) and **`JOE_AGENTIC_ENABLED`** (OFF — gates `ask-joe` write tools). New Inngest fn `joe-daily-brief` (cron `0 11 * * *`) registered in `frontend/api/inngest.ts`. **`ask-joe` is OpenAI-first** and its write tools are propose-only (emit `action` SSE, client executes on approval). All these surfaces pass `RESUME_PARSE_ORDER` (OpenAI-first). See SKILL-joe.md / SKILL-frontend.md.
- **External MCP server (2026-06-21).** `frontend/api/mcp.ts` (`/api/mcp`, a Vercel fn) exposes the CRM over MCP — read + write — for ChatGPT (Developer Mode), Claude, Claude Code. Per-user tokens in `mcp_tokens` (sha256→user) attribute writes; **discovery (`initialize`/`tools/list`) is unauthenticated, `tools/call` is token-gated**; `query` runs read-only SQL via `mcp_run_read_query()` (ON by default, `service_role`-only). **`jobs.status` is actually `lead|hot|closed_lost`** — not the `open/closed` this skill used to list (now corrected below). Full detail in the "MCP Server — `/api/mcp`" section.

### What changed week of 2026-06-27 — new schema you'll hit

Full feature list is in CLAUDE.md ("Shipped week of 2026-06-27"); the DB/backend facts that bite:

- **AI cascade default dropped OpenRouter (`360dac0`).** `DEFAULT_ORDER` = Claude → OpenAI → Gemini; `RESUME_PARSE_ORDER` = OpenAI → Claude → Gemini. `gpt-5.4` is opt-in via `fallbackModel` for `format-resume-ai.ts` + `jobs/[id]/create-bd-sequence.ts`. `ask-joe` keeps its own OpenRouter-tailed cascade. (Fix the "All AI goes through Claude/Anthropic" line in the AI Stack section below — it's been false since the multi-provider cascade.)
- **`interviews` stage table now has a real UI + CHECK constraints** (see "Stage tables" below). Multiple rounds = one row per round (`interviews.round`). New: `interview_interviewers` junction, `interviews.calendar_event_ids jsonb`, `call_logs.interview_id` + `ai_call_notes.interview_id` FKs, `notes.entity_type` now allows `'interview'`.
- **Send-Out → Submission flow** added `scheduled_messages` (`status ∈ {scheduled,sent,canceled,failed}`, owner-RLS + service-role) and new `send_outs` columns (`total_comp_min/max, additional_notes, submission_email jsonb, offer_base/bonus/details`). Endpoints `/api/format-resume-ai`, `/api/send-sendout`; Inngest `send-message-scheduled` (event `messages/send.scheduled.requested`).
- **Soft-delete cascade (`20260625020000`).** Setting `people.deleted_at` soft-deletes its `send_outs` + `candidate_jobs` (new `cascade_deleted_at` cols) and stops active enrollments; restore reverses exactly that cascade. **All reads must filter `deleted_at IS NULL`.** Funnel fix: `candidate_jobs.max_pipeline_stage` ratchet triggers (`20260625010000`).
- **Picklist multi-selects (`20260625000000`, #370).** New `picklist_options` table (`category ∈ department|products|industry|strategy`) + `text[]` columns: `people.departments`/`products`, `jobs.departments`/`products`, `companies.industries`/`strategies` (default `'{}'`; legacy `people.department` backfilled). Not all in generated types.
- **Fuzzy person-matching is now shared.** `frontend/api/lib/fuzzy-match-person.ts` (`findPersonMatches` / `diceSimilarity` — Sørensen–Dice over name 0.6 / firm 0.25 / title 0.15, exact email/linkedin/phone pins ≥0.95) backs dedup scan (`/api/dedup/scan` Pass 2), inbox Add (`/api/search-person`, `/api/update-person`, `/api/inbox/reconcile-unknown`), and the LinkedIn-Recruiter import review (`/api/match-people`). `add-person.ts` gained a `merge_into` mode (keeps existing email+phone, overwrites title/company/LinkedIn/headline/photo, re-queues Unipile resolve).
- **Unipile id resolution is throttled.** New people with a `linkedin_url` get `unipile_resolve_status='pending'`; the `resolve-unipile-ids` Inngest cron (`0 3 * * *`) resolves under a per-account daily budget (`linkedin_resolve_budget` table, default 80, `app_settings.LINKEDIN_RESOLVE_DAILY_CAP`). Person cols: `unipile_resolve_status/attempts/last_attempt_at/last_error`.
- **`reply_sentiment` CHECK widened** to 9 values (adds `ooo`, `booked_meeting`); `intel-extraction.ts` clamps off-vocab → `neutral`.
- **LinkedIn v2 SEND routes finalized** (relation-requests / inbox-scoped chats-send) — see CLAUDE.md Unipile section; the `frontend/src/trigger/` helper path is dead, use `frontend/src/server-lib/`.
- **`inbox_threads` view** recreated to expose `sender_name` + `avatar_url`.

---

## Project Overview

**Sully Recruit** — custom CRM/ATS + communication hub for The Emerald Recruiting Group, a Wall Street staffing firm. Places talent at hedge funds, investment banks, prop trading, asset managers, and fintech.

- **Frontend:** React/TypeScript/Vite → deployed on Vercel (auto-deploys on push to `main`)
- **Backend:** Supabase (project ID: `xlobevmhzimxjtpiontf`)
- **Edge Functions:** Deno (deployed via Supabase MCP)
- **Repo:** github.com/chrissullivan-creator/sully-recruit
- **Local dev:** `C:\Users\Ashley\Downloads\sully-recruit-main\sully-recruit-main` (or Desktop)

---

## Team & Channel Routing

| Person | Email | LinkedIn | SMS |
|---|---|---|---|
| Chris Sullivan (President) | ✅ chris.sullivan@emeraldrecruit.com | recruiter_inmail, classic_message, connection_request | ✅ RingCentral |
| Nancy Eberlein (MD) | ✅ nancy.eberlein@emeraldrecruit.com | recruiter_inmail, classic_message, connection_request | ✅ RingCentral |
| Ashley Leichner (Recruiter) | ✅ ashley.leichner@emeraldrecruit.com | classic_message, connection_request | ❌ No RingCentral |
| House Account | ✅ EmeraldRecruit@theemeraldrecruitinggroup.com | ❌ | ❌ |

**Ashley has email but NO RingCentral. Never route SMS to Ashley.**

---

## Database — Critical Column Names

### Unified person model (Pass 5a, 2026-05-03; renamed Pass 6, 2026-05-03; emails retired 2026-05-07)

**The base table is `people` (was `candidates`).** It holds BOTH candidates and clients. The legacy `candidates` and `contacts` are now both views:
- `candidates` — all rows from `people` (every column visible, plus `email` computed)
- `contacts` — `WHERE type = 'client'` + INSTEAD OF triggers so writes still work

`people.type` is kept in sync with `people.roles TEXT[]` via a BEFORE-trigger (candidate wins when a row carries both roles).

- ~11.5k candidates + ~1.9k clients = ~13.4k total rows
- New code can write to `from('people')` directly. Use `roles: ['candidate']` or `roles: ['client', 'candidate']` for dual roles.
- Plain `email` column was dropped 2026-05-07 — see "What changed" at the top.

### `people` table (base table — formerly `candidates`)
```
id, type, roles (text[]), first_name, last_name, full_name
personal_email, work_email           ← canonical addresses; write here
primary_email                         ← STORED-GENERATED COALESCE(personal_email, work_email)
secondary_emails (text[])             ← extras (import residue) so we don't lose data
phone, mobile_phone
linkedin_url, unipile_provider_id, unipile_recruiter_id, unipile_classic_id
current_title, current_company        ← used for type='candidate'
title, department, company_id, company_name   ← used for type='client'
location_text          ← NOT "location" (that column doesn't exist)
status                 ← ENUM: new | reached_out | engaged   (CHECK-constrained)
owner_user_id, created_by_user_id
job_id, job_status     ← job_status is DEPRECATED, use candidate_jobs.pipeline_stage
resume_url
skills (text[])
candidate_summary, back_of_resume_notes
back_of_resume         ← BOOLEAN, separate from status enum
reason_for_leaving
current_base_comp, current_bonus_comp, current_total_comp
target_base_comp, target_total_comp, comp_notes
work_authorization, relocation_preference, target_locations, target_roles
last_contacted_at, last_responded_at, last_spoken_at
last_comm_channel
last_sequence_sentiment, last_sequence_sentiment_note
joe_says, joe_says_updated_at
linkedin_headline, linkedin_current_company, linkedin_current_title, linkedin_location, linkedin_profile_text, linkedin_last_synced_at, ai_search_text
linked_contact_id      ← self-reference to a counterpart row (same person both candidate AND client)
custom_fields (jsonb)  ← admin-defined custom fields, keyed by custom_field_defs.key (2026-06-14)
```

**⚠️ NEVER use `location` — it's `location_text`**
**⚠️ Valid statuses ONLY: `new`, `reached_out`, `engaged` — NOT `back_of_resume`, `placed`, `dnc`, `stale`, `active`. CHECK constraint enforces this.**
**⚠️ `back_of_resume` is a BOOLEAN column now, not a status value. Set `back_of_resume=true` when comp is added + resume exists.**

### `custom_field_defs` table (2026-06-14)
Admin-defined custom field definitions. Values live in the base table's
`custom_fields JSONB` column (pilot: `people`), keyed by `key`.
```
id, entity_type (candidate|client|company|job), key (immutable slug),
label, field_type (text|number|date|boolean|select|multiselect|url),
options (jsonb[] for select/multiselect), required (UI hint only),
section, display_order, is_active, created_by, created_at, updated_at
UNIQUE (entity_type, key)
```
**⚠️ Not in generated Supabase types — cast `from('custom_field_defs' as any)`.**

### `resumes` table
```
id, candidate_id, file_path, file_name, parser, parsing_status, raw_text, parsed_json
```
**⚠️ This table is called `resumes` NOT `candidate_resumes`. Never use `candidate_resumes` — it doesn't exist.**

### `messages` table
Key columns:
```
id, conversation_id, candidate_id, contact_id
channel, direction (inbound|outbound)
body, subject, sent_at, created_at
sender_address, recipient_address
unipile_message_id, unipile_chat_id
external_conversation_id, integration_account_id
message_type  ← use this for type checks, NOT "metadata" (doesn't exist)
is_read
```
**⚠️ `metadata` column does NOT exist on messages. Use `message_type` instead.**

### `sequence_enrollments` table
```
id, sequence_id, candidate_id, contact_id
status (active|paused|stopped|completed)
current_step_order, next_step_at
stopped_reason, stopped_at, paused_at
waiting_for_connection_acceptance (boolean)
linkedin_connection_status (pending|accepted|already_connected)
linkedin_connection_accepted_at
last_sequence_sentiment, reply_sentiment, reply_sentiment_note
```

### `reply_sentiment` table
```
id, candidate_id, contact_id, enrollment_id
channel, sentiment, summary, raw_message, analyzed_at
```
**Sentiment values:** `interested` | `positive` | `maybe` | `neutral` | `negative` | `not_interested` | `do_not_contact`

### `conversations` table
```
id, candidate_id, contact_id, channel
external_conversation_id, integration_account_id
last_message_preview, last_message_at
is_read, is_archived, assigned_user_id
```

### `candidate_channels` table (Pass 6, 2026-05-03)
Per-candidate per-channel cache for Unipile/provider IDs. **This was missing before Pass 6 and was the root cause of "so many errors" on Trigger.dev tasks.**
```
id, candidate_id, channel (linkedin|linkedin_recruiter|email|sms),
account_id, unipile_id, provider_id, external_conversation_id,
is_connected, connection_status, last_synced_at
UNIQUE (candidate_id, channel)
```
`contact_channels` is a backwards-compat view filtered to type='client' with INSTEAD OF triggers.

### Stage tables (per-job pipeline events)
Each row = one entry into a stage. `candidate_jobs.pipeline_stage` tracks current state; stage tables are the EVENT log.

**UI labels match table names** (pitches → "Pitches", send_outs → "Send Outs", submissions → "Submissions", interviews → "Interviews", placements → "Placements", rejections → "Rejections").

`pitches`, `send_outs`, `submissions`, `placements`, `rejections` carry rich detail: rejection_reason, salary, prior_stage, interviewer_name, etc.

**`interviews` (now a real UI surface — 2026-06-25).** One row per interview **round** for a `candidate_id + job_id` (`interviews.round` int; `frontend/src/lib/createInterview.ts` auto-increments). Auto-created when a send-out reaches an interview stage (`frontend/src/lib/interviewWorkflow.ts`, idempotent on `(send_out_id, round)`). **CHECK constraints (authoritative — fixed `606da`):**
```
interview_type  ∈ {phone_screen, video, onsite, technical, case_study, partner, final}
outcome         ∈ {passed, rejected, no_show, cancelled, pending}
stage           ∈ {to_be_scheduled, scheduled, interview_debrief}   ← "completed" sets stage='interview_debrief', NOT 'completed'; "cancel" only stamps cancelled_at
ai_sentiment    ∈ {positive, neutral, negative, mixed}
debrief_source  ∈ {manual, call_log, email, linkedin, ai}
```
Related: `interview_interviewers (interview_id, contact_id, is_primary)` junction (FK `contact_id → people(id)`); `interviews.calendar_event_ids jsonb` ([{email,id}] per mailbox, written by `/api/interview-calendar-sync` — non-blocking marker to the owner mailbox + always Chris).

### `v_person_activity` view — record of truth
Unified per-person timeline that joins 13 activity sources. Filter by `person_id` for a chronological feed.
```sql
SELECT * FROM v_person_activity WHERE person_id = '<uuid>' ORDER BY happened_at DESC;
```
Activity types: `message | call | ai_note | status_change | stage_change | note | meeting | pitch | sendout | submission | interview | placement | rejection | merge`.

---

## Triggers — Known Issues & Fixes

### `stop_enrollments_on_reply()`
- References `NEW.message_type` (NOT `NEW.metadata` — metadata doesn't exist)
- Stops active enrollments on inbound reply
- Skips stop on `connection_accepted` message_type

### `update_candidate_status_from_inbound()`
- On inbound message, moves `new` → `reached_out` ONLY
- Updates `last_responded_at`, `last_spoken_at`

### `fn_candidate_status_from_timestamps()`
- Auto-promotes `new`/`reached_out` → `engaged` when last_responded_at lands
- Auto-promotes `new` → `reached_out` when last_contacted_at first set

### `auto_back_of_resume()` (Pass 8, fixed 2026-05-03)
- References `resumes` table (NOT `candidate_resumes`)
- Sets `back_of_resume=true` (the BOOLEAN column) when comp is added + resume exists
- DO NOT set `status='back_of_resume'` — that violates the new CHECK constraint

### `trg_update_candidate_last_contact` / `trg_update_contact_last_contact`
- Fire on every message INSERT
- Update `last_contacted_at` (outbound) and `last_responded_at` (inbound)

**⚠️ Before any migration that touches candidates or messages, check these triggers aren't broken.**

---

## Edge Functions

All edge functions use `verify_jwt: false` unless noted.

### API Key Pattern (ALWAYS use this)
```ts
const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??  // secret stored lowercase
  "";
```

### Key Functions
| Function | Version | Purpose |
|---|---|---|
| `run-sequences` | v76+ | Main sequence engine |
| `process-resume` | v69+ | Claude PDF/DOCX parser → Voyage embed |
| `ask-joe` | v104+ | AI assistant, streaming SSE |
| `unipile-webhook` | v29+ | LinkedIn inbound + sentiment |
| `outlook-webhook` | v53+ | Email inbound + sentiment |
| `ringcentral-webhook` | v24+ | SMS inbound + sentiment |
| `backfill-linkedin-messages` | v11+ | LinkedIn message backfill |
| `embed-candidate` | active | Voyage Finance-2 embedding |
| `resolve-unipile-id` | active | LinkedIn slug → Unipile ID |

### `process-resume` Response Shape
```json
{
  "success": true,
  "candidate_id": "uuid",
  "parsed": {
    "first_name": "", "last_name": "", "email": "", "phone": "",
    "current_title": "", "current_company": "",
    "location": "",       ← maps to location_text in DB
    "linkedin_url": "", "skills": []
  }
}
```
**⚠️ `process-resume` already saves the candidate to the DB. Don't insert again — just UPDATE with user edits.**

### `ask-joe` Request Shape
```json
{
  "mode": "draft_message",
  "context": {
    "candidate_id": "uuid",
    "job_id": "uuid",
    "channel": "email",
    "sender": "Chris Sullivan"
  },
  "messages": [{ "role": "user", "content": "..." }]
}
```
Returns SSE stream. Parse with: `data: {"content": "..."}` chunks.

---

## Azure / Microsoft Graph — Two Tenants

| Tenant | Users | App ID | Env Var Prefix |
|---|---|---|---|
| emeraldrecruit.com | Chris + Nancy | `1eceed34-34eb-4b8f-bff5-8622642841cc` | `MICROSOFT_GRAPH_*` |
| theemeraldrecruitinggroup.com | House account | separate app | `MICROSOFT_CLIENT_*` |

**⚠️ Never mix up the two tenants. Chris/Nancy use `MICROSOFT_GRAPH_*`. House uses `MICROSOFT_CLIENT_*`.**

---

## Secrets in Supabase (never hardcode)
```
anthropic_api_key        ← lowercase, use fallback pattern above
UNIPILE_BASE_URL
MICROSOFT_GRAPH_CLIENT_ID / SECRET / TENANT_ID
MICROSOFT_CLIENT_ID / SECRET / TENANT_ID
RINGCENTRAL_*
VOYAGE_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```
**⚠️ Supabase secrets are NOT accessible via MCP. Set/view via Dashboard → Settings → Edge Functions → Secrets.**

---

## Frontend — Vite Environment Variables

**⚠️ Vite ONLY exposes env vars prefixed with `VITE_`. `REACT_APP_*` does NOT work.**

```ts
// CORRECT
import.meta.env.VITE_SUPABASE_URL
import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// WRONG — always undefined in Vite
process.env.REACT_APP_BACKEND_URL
import.meta.env.REACT_APP_BACKEND_URL
```

### Supabase Client Call Pattern
```ts
const resp = await fetch(
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/FUNCTION_NAME`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ... }),
  }
);
```

---

## Domain Model & Pipeline

### Person Engagement Status (`candidates.status`)
`new` → `reached_out` → `engaged`. CHECK-constrained. Same enum applies to both candidate-type and client-type rows.

### Per-Job Pipeline (`candidate_jobs.pipeline_stage`)
`new` → `reached_out` → `pitched` → `send_out` → `submitted` → `interviewing` → `offer` → `placed` | `rejected` | `withdrew`

### Sequence Enrollment Lifecycle (`sequence_enrollments.status`)
`active` | `paused` | `stopped` | `completed`

### Job Lifecycle (`jobs.status`)
`lead` | `hot` | `closed_lost` — these are the **live** values (BD/opportunity pipeline: a job is a search/opportunity). The previously-documented `open`/`on_hold`/`filled`/`closed` never shipped. ⚠️ Don't filter `jobs.status='open'` — it returns 0 rows. "Hot jobs" = `status='hot'`.

### Four Conversion Paths
- Opportunities → Jobs
- Lead Candidates → Candidates (type='candidate')
- Contacts → Clients (type='client')
- Target Companies → Client Companies

See `TERMINOLOGY.md` for the full list of status/stage columns and what each means.

---

## Sequence Engine Rules

1. **Connection request MUST precede LinkedIn message** — hard guardrail in UI + engine skips linkedin_message if no connection
2. **Already connected** → connection request step skipped, advances to next step immediately
3. **Reply detection** uses `hasRepliedSinceEnrollment()` checking both `candidate_id` AND `sender_address`
4. **LinkedIn circuit breaker** — `liLimitHit` Set per account stops all LinkedIn when `limit_exceeded` returned
5. **Send window** — 4:30 AM–9:30 PM CST enforced. Connection requests fire 24/7.
6. **Jitter** — 2–35 min per enrollee + ±43 min per LinkedIn message
7. **`next_step_at = null`** means parked/waiting (not the same as paused)

---

## MCP Servers (`.mcp.json`)

Three MCP servers are configured for Claude Code:

| Server | Package | Purpose | Auth |
|---|---|---|---|
| **Supabase** | `@supabase/mcp-server-supabase` | Run SQL, manage migrations, inspect schema | `SUPABASE_ACCESS_TOKEN` (personal access token from supabase.com/dashboard/account/tokens) |
| **Trigger.dev** | `@trigger.dev/mcp-server` | Manage tasks, schedules, view runs | `TRIGGER_SECRET_KEY` (from Trigger.dev Dashboard → Project Settings) |
| **Unipile** | `mcp-server-unipile` | LinkedIn messaging, profile lookups, connections | `UNIPILE_API_KEY` + `UNIPILE_BASE_URL` (DSN: api19.unipile.com:14926) |

**Project ref:** `xlobevmhzimxjtpiontf`

**⚠️ If an MCP server disconnects, restart the session. Keys are stored in `.mcp.json` at repo root.**

---

## MCP Server — `/api/mcp` (external read/write surface, added 2026-06-21)

`frontend/api/mcp.ts` — a Model Context Protocol server that lets external MCP clients (ChatGPT Developer Mode, Claude, Claude Code, our own Joe) drive the CRM. It is a **Vercel serverless function**, NOT a Supabase edge fn, so it ships on the normal push to `main` (no `supabase functions deploy`).

### Transport & shape
- One POST endpoint, JSON-RPC 2.0 over **Streamable HTTP**. `reply()` content-negotiates: SSE (`event: message\ndata: {…}`) when the request `Accept` includes `text/event-stream` (ChatGPT), else `application/json` (Claude Code). Stateless — no `Mcp-Session-Id`.
- Handles `initialize`, `tools/list`, `tools/call`, `ping`, and notifications (202).
- URLs: `https://app.sullyrecruit.com/api/mcp` and `https://sullyrecruit.app/api/mcp` (both custom domains route to the Vercel project even though `get_project`'s domain list only shows the `*.vercel.app` aliases). Stable Vercel alias: `https://sully-recruit-chrissullivan-1122s-projects.vercel.app/api/mcp`.

### Auth — per-user attribution
- `public.mcp_tokens` (migration `20260621050000`): `token_sha256` (hash only — raw tokens are NEVER stored or committed), `user_id`, `label`, `is_active`. RLS on, no policies → `service_role`-only.
- `resolveActor()` SHA-256s the bearer, looks it up → `{userId, name}`; writes (`owner_user_id`, `created_by_user_id`, `sender_user_id`, `enrolled_by`, note author) use that actor. Falls back to env `MCP_AUTH_TOKEN` → `MCP_ACTOR_USER_ID` (default Chris) for the shared/admin path.
- **Discovery is unauthenticated by design.** `initialize`/`tools/list`/`ping` take no token — ChatGPT lists tools *before* sending the key, so gating discovery → "failed to add connector link". Auth is enforced only on `tools/call`.
- Provisioning a user: generate a random token, store its `sha256` in `mcp_tokens`, hand the raw token to the person; they paste it into their ChatGPT connector (API-key auth). Each recruiter has their own.

### Tools (25 total — 9 reads + 16 writes)
Reads (9): `search` (people/jobs/companies), `get_person` (+`v_person_activity`), `get_job` (+pipeline), `get_company`, `pipeline_report`, `last_touch`, `list_jobs` (status filter), `describe_schema` (introspect), `query` (read-only SQL).
Writes (16): `add_person` (dual-role email merge), `update_person`, `set_do_not_contact`, `add_note`, `tag_person_to_job`, `set_pipeline_stage`, `list_sequences`, `create_sequence` (builds nodes+actions), `enroll_people` (`do_not_contact` guard + fires `sequence/enrollment-init.requested`), `set_enrollment_status`, `add_company` (dedupe by name), `update_company`, `add_job` (resolves `company_id` from name, `num_openings` defaults 1, dedupes on `job_url`), `update_job`, `add_job_contact` (idempotent per job+person, optional `is_primary`), `link_person_to_company` (by `company_id` or `company_name`). Writes respect the same invariants as the app (status enums — jobs `lead|hot|closed_lost`, people `new|reached_out|engaged` — pipeline ladder, `classifyEmail`, `find_company_id_by_name` auto-link).
**Gotcha — stale connector:** ChatGPT caches `tools/list` at connect time, so a newly shipped tool won't appear until the connector is refreshed/reconnected. The recurring "MCP can't create jobs/companies" report is almost always a stale connector showing an old (17/19-tool) snapshot, not a server bug — confirm the live count with a `tools/list` JSON-RPC call before touching `mcp.ts`.

### Raw SQL escape hatch
- `query` (and `describe_schema`) → `mcp_run_read_query(text)` (migration `20260621040000`): SECURITY DEFINER, forces `transaction_read_only`, SELECT/WITH only, ≤1000 rows, 8s timeout, EXECUTE granted to `service_role` only (revoked from anon/authenticated → not an RLS bypass).
- **ON by default**; set `MCP_ENABLE_RAW_SQL=false` to disable.

### Adding a tool
Add an entry to `TOOLS` (name/description/`inputSchema`) and a `case` in `runTool(sb, actor, name, args)`. For writes, prefer reusing an existing endpoint's logic so guardrails hold.

### Gotchas
- New tools don't appear in an already-connected ChatGPT until the connector is **refreshed/reconnected** (it caches `tools/list`).
- You can't curl the domains from the Claude Code sandbox (egress allowlist blocks them). **Test live with Supabase `pg_net`:** `select net.http_post('https://sullyrecruit.app/api/mcp','{…jsonrpc…}'::jsonb,'{}'::jsonb,'{"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":"Bearer <token>"}'::jsonb)` then read `net._http_response`.
- After a squash-merge to `main`, the dev branch diverges (pre-squash commits conflict) — `git reset --hard origin/main` before the next change, then force-push.
- ChatGPT add flow: **Developer Mode** (desktop web, paid plan), not the Deep-Research/Apps search-fetch flow. "Failed to add connector link" is usually a stuck entry → delete + recreate.

---

## AI Stack

| Service | Purpose | Model |
|---|---|---|
| Anthropic Claude | Joe assistant, sentiment, step writing, campaign suggestions, drafting | `claude-sonnet-4-6` (Sonnet), `claude-haiku-4-5-20251001` (Haiku for fast tasks) |
| OpenAI | Resume parsing (lead), in-app résumé formatter + BD sequences (`gpt-5.4` opt-in), Joe fallback | `gpt-4o-mini` default; `gpt-5.4` via `fallbackModel` |
| Google Gemini | Cascade fallback | `gemini-2.5-flash` |
| Voyage Finance-2 | Candidate embeddings for semantic search | `voyage-finance-2` via voyageai.com |

**⚠️ Multi-provider cascade — see `frontend/src/lib/ai-fallback.ts` and CLAUDE.md "Key Rules".** `DEFAULT_ORDER` = Claude → OpenAI → Gemini; `RESUME_PARSE_ORDER` = OpenAI → Claude → Gemini. **OpenRouter was dropped from the default orders 2026-06-26** (provider still exists; re-add if funded). `ask-joe` keeps its own OpenAI → Claude → Gemini → OpenRouter cascade. No Eden AI, no Lovable gateway.

**Semantic search RPC:** `match_candidates(query_embedding, match_count, min_similarity, filter_status)`

---

## Common Mistakes — Never Do These

| ❌ Wrong | ✅ Right |
|---|---|
| `candidate_resumes` table | `resumes` table |
| `location` column | `location_text` column |
| Status `back_of_resume`, `placed`, `dnc`, `stale`, `active` | Only `new`, `reached_out`, `engaged` |
| Set `status='back_of_resume'` | Set boolean `back_of_resume=true` |
| Insert into `contacts` with `company` or `source` columns | Use the unified candidates schema (company_name, no source col) |
| Query `from('people')`, `from('candidate_profiles')`, `from('contact_profiles')`, `from('person_emails')` etc | All dropped in Pass 1; use `candidates` table |
| `NEW.metadata` in triggers | `NEW.message_type` |
| `REACT_APP_*` env vars in frontend | `VITE_*` env vars |
| Call `/functions/v1/parse-resume` | Call `/functions/v1/process-resume` |
| Insert candidate after process-resume | UPDATE only — process-resume already saved it |
| `verify_jwt: true` on edge functions | `verify_jwt: false` for all Sully functions |
| Mix `MICROSOFT_GRAPH_*` with house account | House account uses `MICROSOFT_CLIENT_*` |
| Spread operator base64 on large files | Use `Buffer.from(buffer).toString("base64")` |
| SMS for Ashley | Ashley has no RingCentral — don't route SMS to her |
| Add `candidate_id`+`contact_id` pair on a new table | Use single `person_id` (FK candidates) — see TERMINOLOGY.md |
| Set `search_path = pg_catalog, public` on a function that calls `digest()` | Include `extensions` schema (where pgcrypto lives): `SET search_path = pg_catalog, public, extensions` |

---

## Migration vs SQL Execution

- `apply_migration` — for persistent schema changes (new columns, triggers, indexes, functions)
- `execute_sql` — for reads, previews, and one-off data operations

**Always apply_migration for anything that needs to survive a DB reset.**

---

## GitHub → Vercel Deploy Flow

Push to `main` → Vercel auto-deploys. No manual step. Claude Code commits directly to `main`.

**Claude Code is the preferred way to make frontend changes.** The GitHub MCP connector in claude.ai is read-only — useful for inspecting code, not writing it.

---

## Trigger.dev — 25 active tasks (post Pass 6 cleanup)

Down from 43 in Friday-pre-cleanup state. Categories:

**Inbox sync:** backfill-emails, backfill-linkedin-messages, sync-conversations, purge-marketing-emails, renew-webhook-subscriptions
**Webhook handlers:** webhook-microsoft, webhook-unipile, webhook-ringcentral
**Sequence engine:** sequence-scheduler, send-message, cleanup-stale-enrollments, check-connections
**Resumes:** resume-ingestion, reparse-resumes, reconcile-orphaned-resumes, backfill-resume-embeddings
**Calls:** poll-rc-calls, drain-call-queue, process-call-deepgram
**Calendar:** sync-outlook-events (every 15min), backfill-calendar-events (manual one-shot)
**Plumbing:** unipile-resolve (every 30min), generate-joe-says (called by 5 tasks), fetch-entity-history

**Cut tasks (do NOT recreate):** match-jobs, best-match-job, backfill-avatars, backfill-companies, enrich-linkedin, fetch-company-logos, linkedin-lookup, linkedin-profile-viewers, linkedin-inmail-monitor, sync-outlook-contact, backfill-outlook-contacts, enrich-clay, run-nudge-check, candidate-dedup, sync-activity-timestamps, linkedin-auto-accept, linkedin-engagement, backfill-resume-links.

If a Trigger.dev cron is failing with "task not found" — check the dashboard against this list and delete the orphan schedule.

---

## Reference Docs

- `TERMINOLOGY.md` (repo root) — canonical naming for owner_*, status/stage, person reference columns
- `TRIGGER_DEV_TODO.md` (repo root) — manual cleanup steps from the Pass 6 cleanup
- `claude/SKILL-architecture.md` — this file
- `claude/SKILL-frontend.md`, `SKILL-sequences.md`, `SKILL-webhooks.md`, `SKILL-joe.md`, `SKILL-calls.md`
