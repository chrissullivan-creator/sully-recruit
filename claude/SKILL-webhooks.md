# Sully Recruit — Webhooks & Integrations Skill

## Channel Architecture

| Channel | Provider | Webhook Receiver | Account Owner |
|---|---|---|---|
| LinkedIn | Unipile **v2** | `/api/webhooks/unipile` (Vercel) → `process-unipile-event` (Trigger.dev) | Chris (recruiter), Nancy (recruiter), Ashley (classic) |
| Email | Microsoft Graph / Outlook + Unipile v2 (parallel) | `/api/webhooks/microsoft` + `process-unipile-event` email branch | Chris, Nancy, Ashley, House |
| SMS | RingCentral | `webhook-ringcentral` Trigger.dev task | Chris, Nancy (NOT Ashley) |

---

## Unipile v2 (LinkedIn + Outlook)

We migrated everything off v1. **Use `frontend/src/trigger/lib/unipile-v2.ts:unipileFetch(supabase, accountId, path, init)`** — it handles auth + the v2 path shape (`/api/v2/{account_id}/...`) and pulls config from `app_settings`.

### API path conventions (v2)
- Profile: `linkedin/users/{slug-or-provider-id}`
- Connection invite: `POST linkedin/users/invite`
- Send (Classic OR InMail): `POST chats` — body is `{ attendees_ids: [providerId], text, linkedin?: { api: 'recruiter'|'classic', inmail?: true } }`. **Don't** use `message_type: "INMAIL"` (v1 shape).
- Recruiter projects: `linkedin/recruiter/projects` (and `/talent-pool/applicants` is POST in v2)
- Chat list / messages: `chats`, `chats/{chat_id}/messages`
- Account meta (for health checks): `accounts/{id}` — same in both versions

### Inbound classification (`webhook-unipile.ts`)
The chat object's `content_type === 'inmail'` OR `folder` array including `'INBOX_LINKEDIN_RECRUITER'` → bucket as `linkedin_recruiter`. Everything else → `linkedin`. **Don't** fall back to `integration_account.account_type` alone — a Recruiter seat handles BOTH InMails and Classic DMs, so account_type tagged every Chris message as Recruiter.

`conversations.content_type` is now persisted on insert; `reclassify-linkedin-chats-once` task back-stamps historical rows.

### Webhook signature verification (`/api/webhooks/unipile.ts`)
Unipile sends the secret in any of: `x-unipile-secret`, `x-webhook-secret`, `x-unipile-signature`, `x-webhook-signature`, `x-signature`, `unipile-signature`, or `Authorization: Bearer <secret>`. Verifier accepts all formats + HMAC-SHA256 of the body. Stored in `app_settings.UNIPILE_WEBHOOK_SECRET`.

### LinkedIn Slug Resolution
- Resolution sweep: `unipile-resolve.ts` (Trigger.dev). Hits `linkedin/users/{slug}`.
- Filter garbage slugs: skip anything starting with `ACo` or `acw` (Unipile URNs stored incorrectly as URLs).

### InMail Credit Guard
- `sync-inmail-credits` cron stamps `integration_accounts.inmail_credits_remaining` hourly.
- `sendLinkedIn` refuses to fire an InMail when the cached balance is 0; successful InMails decrement locally between hourly polls.
- Surface in UI when a sequence step is `linkedin_recruiter` and the recruiter's account is low.

### Known Error Codes
| Code | Meaning | Action |
|---|---|---|
| `limit_exceeded` | Daily LinkedIn cap hit | Circuit breaker — skip all LinkedIn for this account run |
| `no_connection_with_recipient` | Not 1st-degree connection | Skip message step, don't fail enrollment |
| `connection_request_already_sent` | Pending request exists | Park enrollment, set waiting_for_connection_acceptance |

### `unipile-webhook` Events
- `new_message` → match sender via `matchPersonByEmail` (multi-column!), bucket via `content_type`/`folder`, log message, run sentiment if inbound
- `connection_accepted` → advance enrollment (unpark from waiting state)
- `message_sent` → update step execution status
- `mail_sent` / `mail_received` → email branch (Outlook via Unipile)

### Inbound invitations
`sync-linkedin-invitations` (every 30 min) pulls `users/invitations/received`, persists into `linkedin_invitations` table, auto-creates a candidate when the inviter doesn't match an existing person (source=`linkedin_inbound_invite`).

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
- Ashley: email enabled, NO SMS (no RingCentral account)

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
