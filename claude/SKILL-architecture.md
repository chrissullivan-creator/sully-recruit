# Sully Recruit — Architecture Skill

## STOP. Read this before writing a single line of code or SQL.

This skill captures hard-won knowledge about the Sully Recruit codebase. Every item here represents a real bug we hit. Don't repeat them.

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
| Chris Sullivan (President) | ✅ chris.sullivan@emeraldrecruit.com | recruiter_inmail, sales_nav_inmail, classic_message, connection_request | ✅ RingCentral |
| Nancy Eberlein (MD) | ✅ nancy.eberlein@emeraldrecruit.com | recruiter_inmail, classic_message, connection_request | ✅ RingCentral |
| Ashley Leichner (Recruiter) | ✅ ashley.leichner@emeraldrecruit.com | classic_message, connection_request | ❌ No RingCentral |
| House Account | ✅ EmeraldRecruit@theemeraldrecruitinggroup.com | ❌ | ❌ |

**Ashley has email but NO RingCentral. Never route SMS to Ashley.**

---

## Database — Critical Column Names

### Unified person model (Pass 5a, 2026-05-03)

**The `candidates` table now holds BOTH candidates and clients via the `type` column.** The old `contacts` table is a backwards-compat VIEW filtered by `type='client'` with INSTEAD OF triggers for writes. See `TERMINOLOGY.md` at repo root for the canonical naming guide.

- 11,331 type='candidate' + 1,868 type='client' = 13,199 total rows
- `from('contacts').insert/update/delete(...)` still works via INSTEAD OF triggers — but new code should write directly to `candidates` with `type='client'`
- Frontend `from('contacts')` queries return clients via the view (slightly slower but correct)

### `candidates` table
```
id, type, first_name, last_name, full_name, email, phone
linkedin_url, unipile_provider_id, unipile_recruiter_id, unipile_classic_id, unipile_sales_nav_id
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
```

**⚠️ NEVER use `location` — it's `location_text`**
**⚠️ Valid statuses ONLY: `new`, `reached_out`, `engaged` — NOT `back_of_resume`, `placed`, `dnc`, `stale`, `active`. CHECK constraint enforces this.**
**⚠️ `back_of_resume` is a BOOLEAN column now, not a status value. Set `back_of_resume=true` when comp is added + resume exists.**

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
id, candidate_id, channel (linkedin|linkedin_recruiter|linkedin_classic|linkedin_sales_nav|email|sms),
account_id, unipile_id, provider_id, external_conversation_id,
is_connected, connection_status, last_synced_at
UNIQUE (candidate_id, channel)
```
`contact_channels` is a backwards-compat view filtered to type='client' with INSTEAD OF triggers.

### Stage tables (per-job pipeline events)
Each row = one entry into a stage. `candidate_jobs.pipeline_stage` tracks current state; stage tables are the EVENT log.

**UI labels match table names** (pitches → "Pitches", send_outs → "Send Outs", submissions → "Submissions", interviews → "Interviews", placements → "Placements", rejections → "Rejections").

`pitches`, `send_outs`, `submissions`, `placements`, `rejections` carry rich detail: rejection_reason, salary, prior_stage, interviewer_name, etc.

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
`open` | `on_hold` | `filled` | `closed`

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

## AI Stack

| Service | Purpose | Model |
|---|---|---|
| Anthropic Claude | Resume parsing, Joe assistant, sentiment, step writing, campaign suggestions | `claude-sonnet-4-20250514` (Sonnet), `claude-haiku-4-5-20251001` (Haiku for fast tasks) |
| Voyage Finance-2 | Candidate embeddings for semantic search | `voyage-finance-2` via voyageai.com |

**⚠️ No OpenAI, Eden AI, or Lovable gateway. All AI goes through Claude/Anthropic.**

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
