# Sully Brain — Custom GPT Action wiring

End-to-end setup for the ChatGPT custom GPT that acts as a read-only
assistant brain over Sully Recruit. Searches people, jobs, companies,
emails, LinkedIn messages, SMS, calls, calendar, notes, and the send-out
pipeline. Hybrid (semantic + keyword) search backed by Postgres FTS and
Voyage `voyage-finance-2` embeddings, plus a candidate→job matcher.

Distinct from the **Send-Out GPT** (`GPT-SENDOUT-ACTION.md`), which is a
write tool. Sully Brain is read-only.

## What the GPT does

The user says things like:

- *"What did Sarah at Jane Street last say?"*
- *"Find me MD-level fixed income candidates in NYC."*
- *"Who's interviewing at Citi next week?"*
- *"Pull up that contact at Two Sigma I emailed in March."*
- *"Rank candidates for the new Goldman quant dev role."*
- *"What's been happening with John Smith lately?"*

The GPT calls the right `/api/brain/*` endpoint, gets back JSON, and
answers in plain English with names, IDs, and verbatim quotes from the
underlying records.

## Backend pieces (this branch)

Every endpoint lives under `frontend/api/brain/` and uses the shared
`requireAuth` helper. Auth = `Authorization: Bearer <token>` where
`<token>` is the Supabase service-role key (what the GPT sends) or a
logged-in user JWT.

| Path | OperationId | Purpose |
|---|---|---|
| `GET  /api/brain/openapi` | — | OpenAPI 3.1 spec for the GPT Action (paste-able). |
| `GET  /api/brain/health` | `healthCheck` | Smoke test. Returns row counts + key presence. |
| `POST /api/brain/search` | `searchEverything` | Hybrid (FTS + semantic) search over everything. |
| `POST /api/brain/person` | `getPerson` | Person detail by id or free-text. |
| `POST /api/brain/person-comms` | `getPersonCommunications` | Last N messages + calls for a person. |
| `POST /api/brain/person-notes` | `getPersonNotes` | Recent recruiter notes. |
| `POST /api/brain/jobs` | `searchJobs` | Search open jobs. |
| `POST /api/brain/job` | `getJob` | Job detail + send-outs by stage. |
| `POST /api/brain/companies` | `searchCompanies` | Companies with jobs/contacts counts. |
| `POST /api/brain/match-candidates` | `matchCandidatesToJob` | Rank candidates against a job. |
| `POST /api/brain/calendar` | `getCalendar` | Outlook + internal events. |
| `POST /api/brain/recent-activity` | `getRecentActivity` | Unified timeline. |
| `POST /api/brain/live-conversations` | `getLiveConversations` | Live Unipile fetch — bypasses DB cache for freshest LinkedIn chats per person. |
| `POST /api/brain/sync-history` | `syncPersonHistory` | Kick the message-history backfill for unsynced people. |
| `POST /api/brain/find-linkedin-urls` | `findMissingLinkedinUrls` | Kick the LinkedIn URL finder (Apollo → Unipile fallback). |

Plus the embedding backfill that makes semantic search actually work:

- **Cron** every 5 min: `backfillSearchDocumentsEmbeddings` Inngest function.
- **Manual kick**: `POST /api/trigger-backfill-search-embeddings`
  (body `{ "batches": 5 }` to drain up to ~480 rows in one shot).
- **Scope**: candidates / contacts / companies / resumes / calls / notes
  / send_outs / jobs. Excludes `message` rows — those wait for the
  upstream sync to link them to people before being embedded.

## Setup checklist

### 1. Deploy

Push this branch and let Vercel auto-deploy. No new env vars — uses the
existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `VOYAGE_API_KEY`.

### 2. Drain the embedding backlog (one-time)

When this ships, only ~5% of `search_documents` rows have embeddings, so
semantic search will be weak until the Inngest cron catches up.

Either let the 5-minute cron drain it (≈11 hours at 12.5k rows) or kick
it manually a few times:

```bash
curl -s -X POST "$DOMAIN/api/trigger-backfill-search-embeddings" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"batches": 5}' | jq .
# repeat every 30-60s until backlog_remaining == 0
```

Check progress with `healthCheck` (returns `search_documents_embedded`
vs `search_documents_total`).

### 3. Get the bearer token

In Supabase → **Project Settings → API** copy the `service_role` secret.
This is what the GPT sends as `Authorization: Bearer …` on every call.
Treat it like a god-mode credential — anyone with the GPT can use it.

### 4. Create the custom GPT

Inside ChatGPT (your Emerald Team workspace):

1. **Configure → Instructions** — paste Appendix A below.
2. **Configure → Actions → Create new action**:
   - **Authentication**: API Key → **Auth Type: Bearer** → paste the
     Supabase `service_role` value.
   - **Schema**: fetch from `https://<your-vercel-domain>/api/brain/openapi`
     (the endpoint serves the OpenAPI 3.1 JSON, and ChatGPT can import a URL).
     Or paste Appendix B (the full spec) if you prefer to pin it.
   - **Privacy policy URL**: workspace-only GPT, so use the Emerald
     privacy URL or skip per workspace policy.
3. **Sharing**: **"Only people in my workspace"**.

### 5. Smoke test

In the GPT:

- *"Health check"* — should call `healthCheck`, return DB counts.
- *"Find Jane at Jane Street"* — `searchEverything` then `getPerson`.
- *"What did we last hear from her?"* — `getPersonCommunications`.
- *"Rank candidates for job <uuid>"* — `matchCandidatesToJob`.

Failure modes:

- 401 → bearer token is wrong / missing.
- 500 from `match-candidates` → `VOYAGE_API_KEY` not set.
- Semantic results feel weak → embedding backlog not drained yet
  (see step 2).

## Appendix A — GPT system instructions

```
You are Sully Brain, the read-only assistant brain for The Emerald
Recruiting Group on top of Sully Recruit. Sharp, direct, senior Wall
Street recruiter energy — the same voice as Joe inside the app. Punchy,
no walls of text.

What you do:
- Answer questions about people, jobs, companies, communications,
  calendar, send-outs, and the pipeline by calling the actions below.
- Never invent names, IDs, dates, quotes, comp figures, or pipeline
  stages. If the data isn't in the result, say so.
- When you reference a person or job, include their ID in parentheses
  so the recruiter can jump to their page.

How to pick the right tool:

1. Ambiguous / broad question ("what's going on with X?", "find me…")
   → searchEverything first. Then drill in with getPerson / getJob.

2. Specific person by name → getPerson (with `query`). If multiple
   matches come back, list them and ask the user to pick before going
   further.

3. "What did they last say?" / "did we hear back from…" →
   getPersonCommunications. Quote verbatim from the body / ai_summary
   fields. Note the channel (email vs LinkedIn vs phone) and date.

4. "What does my calendar look like with X?" / "Who am I meeting?" →
   getCalendar with the relevant person_id and/or date range.

5. "Rank candidates for this role" → if the user named an existing job
   you can find via searchJobs, pass that `job_id` to
   matchCandidatesToJob. Otherwise pass title + description directly.
   Present the top 5-10 with current_title at current_company plus 1
   sharp sentence on fit.

6. "What's happening lately?" / "What did I do this week?" →
   getRecentActivity, scoped to the user's person_id if relevant.

Hard rules:
- Read-only — you have no write tools.
- Don't fabricate. If a field is null in the response, treat it as
  unknown, not as proof that the thing doesn't exist.
- Don't fabricate IDs to make up follow-ups; chain the IDs from one
  call's response into the next call's input.
- Compensation, visa, "where_interviewed", "where_submitted" are real
  fields on the person record — surface them when relevant, leave them
  alone when not asked.
- Person statuses: only `new`, `reached_out`, `engaged`. Anything else
  is a stale value, ignore it.
```

## Appendix B — OpenAPI spec

The spec is served live at:

```
https://<your-vercel-domain>/api/brain/openapi
```

ChatGPT can import that URL directly under Actions → Schema → "Import
from URL". The endpoint always returns the current production shape, so
adding a new endpoint here updates the GPT on the next deploy without
re-pasting.

If you'd rather pin a snapshot into ChatGPT, fetch the JSON once:

```bash
curl -s "$DOMAIN/api/brain/openapi" > brain.openapi.json
# paste contents into ChatGPT → Actions → Schema
```

## Appendix C — curl smoke tests

```bash
DOMAIN="https://www.sullyrecruit.app"
SR_KEY="<supabase service_role key>"

# Health
curl -s "$DOMAIN/api/brain/health" \
  -H "Authorization: Bearer $SR_KEY" | jq .

# Universal search
curl -s -X POST "$DOMAIN/api/brain/search" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"fixed income trader NYC","limit":8}' | jq .

# Person by name
curl -s -X POST "$DOMAIN/api/brain/person" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Jane Smith"}' | jq .

# Last communications
curl -s -X POST "$DOMAIN/api/brain/person-comms" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"person_id":"<uuid>","limit":10}' | jq .

# Match candidates to existing job
curl -s -X POST "$DOMAIN/api/brain/match-candidates" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"job_id":"<uuid>","limit":10}' | jq .

# Calendar lookahead
curl -s -X POST "$DOMAIN/api/brain/calendar" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from_date":"2026-05-23","to_date":"2026-05-30"}' | jq .
```

## Message sync — design rules

**Long-term archive (DB):** only messages that can be linked to a known
person live in the `messages` table. The fetch-entity-history Inngest
function attributes every insert to a `candidate_id` / `contact_id`
upfront, so person-comms queries are clean. Unlinked inbound emails
(LinkedIn newsletters, Microsoft system mail, internal Emerald-to-
Emerald) do land in the table from webhooks today — they don't surface
in /person-comms because that endpoint filters by person_id, but they
do bloat row counts.

**Fresh fetch (live):** `/api/brain/live-conversations` calls Unipile
v1 on demand for one person's LinkedIn (Classic + Recruiter) chats.
Useful when:
- the DB cache feels stale,
- the chat was never linked (no candidate_channels row), or
- you want messages that arrived between sync ticks.

This endpoint never writes to the DB. The 2-hour `sync-conversations`
cron and the on-demand `fetch-entity-history` job are the only message
writers.

## Active integration accounts — known gap

As of 2026-05-23 there are **zero active Unipile email accounts** —
`fetch-entity-history` cannot backfill email history. Inbound emails
still land via the Microsoft Graph webhook so live mail keeps flowing,
but historical email pulls for a person are a no-op until the email
account is reconnected under Settings → Integrations.

LinkedIn coverage today: 1× linkedin_classic + 2× linkedin_recruiter
accounts active. Both fan into `messages.channel='linkedin'` and
`messages.channel='linkedin_recruiter'` respectively.

## Embedding backfill — how to think about it

The hybrid search uses two RPCs:

- `search_search_documents(query)` — Postgres FTS over `search_documents.fts`.
  Always works. Pure keyword.
- `match_search_documents(embedding)` — pgvector cosine over
  `search_documents.embedding`. Only works on rows where the embedding
  column is non-null.

Both run in parallel and fuse with Reciprocal Rank Fusion in
`frontend/api/lib/brain-hybrid-search.ts`. So even with zero embeddings
the search still returns hits — it just degrades to keyword-only. As the
backfill cron drains, semantic recall improves.

If you ever wipe `search_documents.embedding` (model swap, etc.), the
cron will re-fill from scratch — no manual reset needed.
