# Sully Recruit — Webhooks & Integrations Skill

## Channel Architecture

| Channel | Provider | Webhook Receiver | Account Owner |
|---|---|---|---|
| LinkedIn | Unipile (reads v1, **sends v2**) | `/api/webhooks/unipile` (Vercel) → `process-unipile-event` (**Inngest**) | Chris (recruiter), Nancy (recruiter), Ashley (classic) |
| Email | Microsoft Graph / Outlook + Unipile (parallel) | `/api/webhooks/microsoft` + `process-unipile-event` email branch | Chris, Nancy, Ashley, House |
| SMS | RingCentral | `process-ringcentral-event` (**Inngest**) | Chris, Nancy (NOT Ashley) |

> The webhook handlers run on **Inngest** now (`frontend/api/lib/inngest/functions/process-*-event.ts`), not Trigger.dev — the `src/trigger/` name elsewhere is a holdover. See CLAUDE.md.

---

## Unipile v1/v2 split (LinkedIn + Outlook)

**Reads + email/calendar are still v1; LinkedIn _sends_ (classic DM / InMail / connection request) run on v2.** See CLAUDE.md for the full v1/v2 table. The live helpers are in **`frontend/src/server-lib/unipile-v2.ts`** (`unipileFetch()` = v1, `unipileFetchV2()` = v2; the `frontend/src/trigger/lib/` path is the dead Trigger.dev holdover). LinkedIn sends go through **`frontend/src/server-lib/send-channels.ts`** (`sendLinkedIn` → `sendLinkedInV2` when the account resolves to an `acc_xxx` id via `getUnipileAccountV2IdByV1Id()` and `isLinkedinV2SendEnabled()`, else the v1 fallback).

### LinkedIn send routes — v2 (live, updated 2026-06-24, `send-channels.ts`)
The v2 send route templates live in `linkedinV2SendPaths` and dispatch in `sendLinkedInV2()`. **These replaced the old `POST chats` / `users/invite` shapes — do NOT use the old ones on v2 (they 404/501).**

| Send type | v2 route (`POST /v2/{acc_xxx}/…`) | Body |
|---|---|---|
| **Connection request** | `users/me/relation-requests` | `{ user_id: providerId, message?: note }` — key is **`user_id`** (not `provider_id`), note key is **`message`** |
| **Recruiter InMail** | `inboxes/RECRUITER_PRIMARY/chats/send` | `{ text, users_ids: [providerId], specifics: { linkedin: { recruiter: { subject, signature } } } }` — both `subject` + `signature` required (`signature` = sender `profiles.display_name` via `getLinkedInSenderName()`) |
| **Classic DM** | `chats/send` | `{ text, users_ids: [providerId], specifics: { linkedin: { classic: {} } } }` |

⚠️ Body key is **`specifics`** (NOT `options`), recipient key is **`users_ids`** (NOT `attendees_ids`). The top-level `chats/send` route **501s for recruiter** — InMail MUST use the inbox-scoped `inboxes/RECRUITER_PRIMARY/chats/send`. `users/invite` is v1-only (404s on v2). The `USE_LINKEDIN_INBOX_API` flag + `sendViaInboxEndpoint()` in send-channels are **dead/disabled** — leave OFF.

### API path conventions (v1, still in use for reads)
- Profile: `linkedin/users/{slug-or-provider-id}` (lookup adds `?with_sections=linkedin_experience` + a `variant=linkedin_recruiter` retry to resolve InMail senders — see lookup-linkedin below)
- Recruiter projects: `linkedin/recruiter/projects` (read-only — no programmatic create/pipeline-save; see CLAUDE.md)
- Chat list / messages: `chats`, `chats/{chat_id}/messages`
- Account meta (for health checks): `accounts/{id}` — same in both versions

### `lookup-linkedin` — resolve InMail senders (2026-06-27, #377)
`frontend/api/lookup-linkedin.ts` prefills the inbox "Add person" form. InMail senders arrive as an `AEM…` provider URN that the classic profile read can't resolve, so the form came up empty. Fix: the v2 profile read now passes **`with_sections=linkedin_experience`** (fills current title/company that drive the people↔companies auto-link) and, after the classic id/account loop fails, retries every id/account with **`variant=linkedin_recruiter`** before the chat fallback — that's what resolves InMail senders and prefills name/title/company/photo.

### Inbound classification (`webhook-unipile.ts`)
The chat object's `content_type === 'inmail'` OR `folder` array including `'INBOX_LINKEDIN_RECRUITER'` → bucket as `linkedin_recruiter`. Everything else → `linkedin`. **Don't** fall back to `integration_account.account_type` alone — a Recruiter seat handles BOTH InMails and Classic DMs, so account_type tagged every Chris message as Recruiter.

`conversations.content_type` is now persisted on insert; `reclassify-linkedin-chats-once` task back-stamps historical rows.

### Inbound auto-add (2026-06-21)
An inbound LinkedIn message (classic DM **or** Recruiter InMail) from a sender **not already in the CRM now auto-creates the person** — `type='candidate'`, `needs_classification=true`, `auto_added_source='classic_message'` (DM) or `'recruiter_inmail'` (InMail) — and mirrors the provider id into `candidate_channels` so the next message hard-matches. See `processLinkedInMessage` in `frontend/api/lib/inngest/functions/process-unipile-event.ts` (live path; the Deno `unipile-webhook` edge fn is legacy/unused — 0 invocations). Previously **only InMail** auto-created and classic DMs from unknown senders were *dropped* ("Phase 5 rule"); that drop is now only a fallback when auto-add can't run (no `owner_user_id` on the integration account). Auto-added people surface in Data Cleanup (`needs_classification`) for review. Requires a valid integration account — note Nancy's LinkedIn (no v2 id + v1 id 404s) must be reconnected before her inbound will attach.

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

## Email noise / marketing filter (`marketing-blocklist.ts`, updated 2026-06-27)

`frontend/src/server-lib/marketing-blocklist.ts` is the single noise/marketing
classifier — `isMarketingEmail(senderAddress)` plus `MARKETING_DOMAINS` and
`MARKETING_SENDER_PATTERNS`. Consumed by the Inngest fns
`purge-marketing-emails.ts` (daily sweep) and `backfill-emails.ts` (skip on
ingest).

- **NEW (#382): ALL `linkedin.com` / `*.linkedin.com` senders are now noise —
  including `hit-reply@linkedin.com`** (previously kept). Real LinkedIn
  conversations arrive through the LinkedIn message channel, not email relays,
  so every LinkedIn email is treated as a notification/marketing relay.
- `MARKETING_DOMAINS` expanded (efinancialcareers, ziprecruiter, topechelon,
  ccsend, plus retail/travel/finance promo senders); `alerts@`, `notify@`,
  `postmaster@` added to `MARKETING_SENDER_PATTERNS`. The #382 ship also one-off
  archived ~4,000 existing LinkedIn/newsletter conversations.

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
6. If inbound: run `extractMessageIntel` + OOO detection
7. If OOO: tag the message `message_type='auto_reply'`, reschedule active sequence steps, and do **not** stamp `last_responded_at`
8. If genuine reply: write sentiment/intel, stamp `last_responded_at`, stop active enrollments, and refresh Joe
9. If bounce/returned mail/not-delivered: set `email_invalid`, stop active enrollments, and surface the warning in the UI

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
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact|ooo|booked_meeting",
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

// Stamp on person profile
await supabase.from("people").update({
  last_sequence_sentiment: result.sentiment,
  last_sequence_sentiment_note: result.summary,
}).eq("id", person_id);
```

**⚠️ `do_not_contact` classification = AUTO-STOP enrollment immediately (compliance)**
**⚠️ `ooo` classification = reschedule, not a human reply; do not count it as `last_responded_at`.**
**⚠️ bounces/returned/not-delivered = `email_invalid` + stop sequence work; do not count as a response.**

---

## Backfill Functions

| Function | Purpose | Runs |
|---|---|---|
| `backfill-linkedin-messages` | Pull LinkedIn message history from Unipile | Every 60s via cron |
| `backfill-emails` | Pull email history from Outlook | Every 60s via cron |
| `backfill-resume-emails` | Process "Resumes Supabase" Outlook folder (~2,800 emails) | On demand |

### `backfill-linkedin-messages` Known Behavior
- Creates conversation record with preview even when individual messages fail
- Messages can fail to attach if identity resolution misses the person; check the backfill/Inngest logs plus `candidate_id` / `contact_id` on inserted `messages`.
- Runs for Chris's account by default; pass `account_email` in body to run for others

---

## Reply Detection — Stop Trigger

Live reply stopping is handled in the Inngest webhook processors and backed up
by `runSequenceAction`:

- Microsoft/Unipile email handlers classify OOO before stamping
  `last_responded_at`. OOO rows are `message_type='auto_reply'` and reschedule
  the next sequence step instead of stopping.
- Genuine inbound replies stop active enrollments immediately via
  `stopEnrollment(..., 'reply_received')`; the runner also calls
  `hasRepliedSinceEnrollment()` before any send.
- `hasRepliedSinceEnrollment()` excludes `message_type IN
  ('connection_accepted','auto_reply')`, so connection accepts and OOO do not
  kill a cadence.
- Bounce handlers set `email_invalid=true` and stop active enrollments with
  `stop_trigger='email_bounced'`; send-time preflight uses
  `email_invalid_bounced`.

**If replies aren't stopping sequences:**
1. Confirm `candidate_id`/`contact_id` is populated on the inbound message row.
2. Confirm `message_type` is not `connection_accepted` or `auto_reply`.
3. Verify `status = 'active'` on the enrollment (not `paused` / `stopped`).
4. Check the Microsoft/Unipile Inngest function logs for the matching inbound.
