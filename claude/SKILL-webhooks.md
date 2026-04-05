# Sully Recruit — Webhooks & Integrations Skill

## Channel Architecture

| Channel | Provider | Webhook Function | Account Owner |
|---|---|---|---|
| LinkedIn | Unipile | `unipile-webhook` | Chris (sales nav), Nancy (recruiter), both (classic) |
| Email | Microsoft Graph / Outlook | `outlook-webhook` | Chris, Nancy, House |
| SMS | RingCentral | `ringcentral-webhook` | Chris, Nancy (NOT Ashley) |

---

## Unipile (LinkedIn)

### API Pattern
```ts
// Trigger.dev tasks: use getUnipileBaseUrl() from ./lib/supabase (reads app_settings.UNIPILE_BASE_URL)
// Supabase edge functions: Deno.env.get("UNIPILE_BASE_URL") with fallback
const baseUrl = await getUnipileBaseUrl(); // https://api19.unipile.com:14926/api/v1
headers: { "X-API-KEY": account.access_token, "Accept": "application/json" }
```

### LinkedIn Slug Resolution
- Use `resolve-unipile-id` edge function, NOT direct Unipile API calls
- Pass just the slug (e.g. `christophersullivan15`), not full URL
- Filter garbage slugs: skip anything starting with `ACo` or `acw` (Unipile URNs stored incorrectly)

### Known Error Codes
| Code | Meaning | Action |
|---|---|---|
| `limit_exceeded` | Daily LinkedIn message cap hit | Circuit breaker — skip all LinkedIn for this account run |
| `no_connection_with_recipient` | Not 1st-degree connection | Skip message step, don't fail enrollment |
| `connection_request_already_sent` | Pending request exists | Park enrollment, set waiting_for_connection_acceptance |

### `unipile-webhook` Events
- `new_message` → log message, run sentiment if inbound
- `connection_accepted` → advance enrollment (unpark from waiting state)
- `message_sent` → update step execution status

### Unipile ID Resolution
570 candidates still need Unipile IDs resolved (as of last run).
Script: `resolve_unipile_bulk.py` on Ashley's Desktop.
Calls `resolve-unipile-id` edge function at 3 concurrent req/sec with resume capability.

---

## Microsoft Graph (Email)

### Two Tenants
```
Tenant 1 (Chris + Nancy):
  App ID: 1eceed34-34eb-4b8f-bff5-8622642841cc
  Tenant: 533889c7-6c40-4a16-a5d0-d8c67e14ab8a
  Secrets: MICROSOFT_GRAPH_CLIENT_ID, MICROSOFT_GRAPH_CLIENT_SECRET, MICROSOFT_GRAPH_TENANT_ID

Tenant 2 (House account):
  Domain: theemeraldrecruitinggroup.com
  Secrets: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_CLIENT_TENANT_ID
```

### Graph Subscriptions
- Expire every **3 days** — must be renewed
- Watch `created` events on mailbox
- `hasAttachments` field is **unreliable on forwarded emails** — never filter on it for resume scanning
- Subscription renewal should be automated (check if cron is running)

### `outlook-webhook` Flow
1. Graph fires webhook on new email
2. Fetch full message via Graph API
3. Strip HTML → plain text
4. Match sender/recipient to candidate/contact by email address
5. Insert into `messages` table
6. If inbound: run Claude Haiku sentiment analysis
7. Write to `reply_sentiment` + stamp candidate profile

---

## RingCentral (SMS)

### `ringcentral-webhook` Flow
1. RC fires webhook on new SMS
2. Match sender number to candidate/contact
3. Insert into `messages` table
4. If inbound: run Claude Haiku sentiment

### Channel Routing
- Chris: SMS enabled
- Nancy: SMS enabled
- Ashley: NO SMS (no RingCentral account)

---

## Sentiment Analysis Pattern (All 3 Channels)

```ts
// Claude Haiku — fast, cheap, accurate enough for sentiment
const model = "claude-haiku-4-5-20251001";

const prompt = `Analyze this reply and return JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact",
  "summary": "one sentence note for the recruiter"
}

Reply: "${strippedBody}"`;

// Write to reply_sentiment table
await supabase.from("reply_sentiment").insert({
  candidate_id, enrollment_id, channel,
  sentiment: result.sentiment,
  summary: result.summary,
  raw_message: body,
  analyzed_at: new Date().toISOString(),
});

// Stamp on candidate profile
await supabase.from("candidates").update({
  last_sequence_sentiment: result.sentiment,
  last_sequence_sentiment_note: result.summary,
}).eq("id", candidate_id);
```

**⚠️ `do_not_contact` classification = AUTO-STOP enrollment immediately (compliance)**

---

## Backfill Functions

| Function | Purpose | Runs |
|---|---|---|
| `backfill-linkedin-messages` | Pull LinkedIn message history from Unipile | Every 60s via cron |
| `backfill-emails` | Pull email history from Outlook | Every 60s via cron |
| `backfill-resume-emails` | Process "Resumes Supabase" Outlook folder (~2,800 emails) | On demand |

### `backfill-linkedin-messages` Known Behavior
- Creates conversation record with preview even when individual messages fail
- Messages fail silently if triggers are broken (check `stop_enrollments_on_reply` and `update_candidate_status_from_inbound`)
- Runs for Chris's account by default; pass `account_email` in body to run for others

---

## Reply Detection — Stop Trigger

The `stop_enrollments_on_reply()` DB trigger fires on every message INSERT:

```sql
-- Fires on inbound messages only
-- Uses message_type column (NOT metadata — doesn't exist)
-- connection_accepted → updates linkedin_connection_status only (doesn't stop)
-- All other inbound → stops active enrollments for candidate/contact
```

**If replies aren't stopping sequences:**
1. Check trigger exists and references `message_type` not `metadata`
2. Check `candidate_id`/`contact_id` is populated on the message row
3. Verify `status = 'active'` on the enrollment (not `paused`)
