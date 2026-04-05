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
| Chris Sullivan (President) | ✅ chris.sullivan@emeraldrecruit.com | sales_nav_inmail, classic_message, connection_request | ✅ RingCentral |
| Nancy Eberlein (MD) | ✅ nancy.eberlein@emeraldrecruit.com | recruiter_inmail, classic_message, connection_request | ✅ RingCentral |
| Ashley Leichner (Recruiter) | ❌ No email integration | classic_message, connection_request ONLY | ❌ No RingCentral |
| House Account | ✅ EmeraldRecruit@theemeraldrecruitinggroup.com | ❌ | ❌ |

**Ashley has NO email account and NO RingCentral. Never route email or SMS to Ashley.**

---

## Database — Critical Column Names

### `candidates` table
```
id, first_name, last_name, full_name, email, phone
linkedin_url, unipile_id
current_title, current_company
location_text          ← NOT "location" (that column doesn't exist)
status                 ← ENUM: new | reached_out | back_of_resume | placed
owner_id, owner_user_id
job_id, job_status
resume_url
skills (text[])
candidate_summary, back_of_resume_notes
reason_for_leaving
current_base_comp, current_bonus_comp, current_total_comp
target_base_comp, target_total_comp, comp_notes
work_authorization, relocation_preference, target_locations, target_roles
last_contacted_at, last_responded_at, last_spoken_at
last_comm_channel
last_sequence_sentiment, last_sequence_sentiment_note
joe_says, joe_says_updated_at
```

**⚠️ NEVER use `location` — it's `location_text`**
**⚠️ Valid statuses ONLY: `new`, `reached_out`, `back_of_resume`, `placed` — NOT `engaged`, `contacted`, or anything else**

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

---

## Triggers — Known Issues & Fixes

### `stop_enrollments_on_reply()`
- References `NEW.message_type` (NOT `NEW.metadata` — metadata doesn't exist)
- Stops active enrollments on inbound reply
- Skips stop on `connection_accepted` message_type

### `update_candidate_status_from_inbound()`
- On inbound message, moves `new` → `reached_out` ONLY
- Does NOT set `engaged` (not a valid status)
- Updates `last_responded_at`, `last_spoken_at`

### `auto_back_of_resume()`
- References `resumes` table (NOT `candidate_resumes`)
- Moves candidate to `back_of_resume` when comp is added and resume exists

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

### Candidate Pipeline
`new` → `reached_out` → `back_of_resume` → `placed`

### Candidate Job Status (separate from candidate status)
`new` → `reached_out` → `pitched` → `send_out` → `submitted` → `interviewing` → `offer` → `placed` | `rejected` | `withdrew`

### Sequence Pipeline
`Warm` → `Hot` → `Interviewing` → `Offer` → `Accepted` | `Declined` | `Lost` | `On Hold`

### Four Conversion Paths
- Opportunities → Jobs
- Lead Candidates → Candidates
- Contacts → Clients
- Target Companies → Client Companies

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

## AI Stack

| Service | Purpose | Model |
|---|---|---|
| Anthropic Claude | Resume parsing, Joe assistant, sentiment, step writing | `claude-sonnet-4-20250514` (Sonnet), `claude-haiku-4-5-20251001` (sentiment) |
| Voyage Finance-2 | Candidate embeddings for semantic search | `voyage-finance-2` via voyageai.com |
| OpenAI | NOT USED for AI — embeddings only in legacy `search-resumes` | — |

**Semantic search RPC:** `match_candidates(query_embedding, match_count, min_similarity, filter_status)`

---

## Common Mistakes — Never Do These

| ❌ Wrong | ✅ Right |
|---|---|
| `candidate_resumes` table | `resumes` table |
| `location` column | `location_text` column |
| Status `engaged` or `contacted` | `reached_out` |
| `NEW.metadata` in triggers | `NEW.message_type` |
| `REACT_APP_*` env vars in frontend | `VITE_*` env vars |
| Call `/functions/v1/parse-resume` | Call `/functions/v1/process-resume` |
| Insert candidate after process-resume | UPDATE only — process-resume already saved it |
| `verify_jwt: true` on edge functions | `verify_jwt: false` for all Sully functions |
| Mix `MICROSOFT_GRAPH_*` with house account | House account uses `MICROSOFT_CLIENT_*` |
| Spread operator base64 on large files | Use `Buffer.from(buffer).toString("base64")` |
| Email/SMS for Ashley | Ashley = LinkedIn only (no email, no RingCentral) |

---

## Migration vs SQL Execution

- `apply_migration` — for persistent schema changes (new columns, triggers, indexes, functions)
- `execute_sql` — for reads, previews, and one-off data operations

**Always apply_migration for anything that needs to survive a DB reset.**

---

## GitHub → Vercel Deploy Flow

Push to `main` → Vercel auto-deploys. No manual step. Claude Code commits directly to `main`.

**Claude Code is the preferred way to make frontend changes.** The GitHub MCP connector in claude.ai is read-only — useful for inspecting code, not writing it.
