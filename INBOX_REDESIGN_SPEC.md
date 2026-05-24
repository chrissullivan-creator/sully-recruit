# Inbox Redesign — Spec

**Status:** Draft for review
**Owner:** Chris
**Last updated:** 2026-05-24
**Branch:** `claude/magical-tesla-jVUCk`

This is a design spec, not a build plan yet. Review, push back, then we phase it.

---

## 0. Decisions locked in (as of 2026-05-24)

Tracking answers as they come in.

| # | Decision | Choice |
|---|---|---|
| 1 | Live-fetch cap | **100 per channel per person**, scrollable (cursor pagination), filterable by channel + person + "all" |
| 1a | Compose new message/email to a person | **Yes** — prominent "New message" button in inbox list, channel picker driven by what we have for the person |
| 2 | Default density | **Comfortable** (Claude's call — Chris said "your call") |
| 3 | Focused = persisted (in CRM), Other = live unknown senders | **Yes** |
| 4 | Auto-add default type | **AI-guess** based on email domain + signature + message context (candidate vs client). Falls back to `candidate` + `needs_classification=true` if guess is low-confidence |
| 5 | Deny-list for auto-add | **Yes** — own domain, distribution lists, common service addresses (`support@`, `noreply@`, etc.) |
| 7 | Backfill — when person added, multi-stage enrichment + backfill | **Yes**: Stage 1a = if LinkedIn URL → fill profile fields from Unipile + capture URN/attendee IDs; Stage 1b = cross-channel ID resolution; Stage 1c = third-party enrichment for missing email/phone (**provider TBD — Chris to choose**); Stage 2 = backfill messages across email + LinkedIn + SMS |
| 7a | Backfill lookback window | **Email: back to 2019. LinkedIn: forever** (no cap) |
| 8 | One-time backfill on existing people | **Yes** — sent + received. Must accurately populate `people.last_contacted_at` and `people.last_responded_at` as it runs |
| 16 | Sequence cross-channel AI soft-match | **Yes** — stop on soft-match AND run enrichment API to confirm. On confirmed match, persist new channel ID. On low-confidence, send to Data Cleanup |
| 17 | Pre-enrollment warning | **No warning** — auto-run enrichment to fill missing channel data. Ambiguous matches → **Data Cleanup** view |
| 17a | **Data Cleanup Settings view (new)** | New page rolling up: enrichment ambiguity, needs-classification (auto-added people), and existing duplicates (CollisionReview merged in) |
| 11 | AI tagging on non-persisted inbound | **Skip** to save cost. Backfill covers it once the person is added |
| 12 | Snooze wake | **Push notification** when a snoozed thread wakes |
| 13 | Cleanup of existing 21k unlinked messages | **Leave as-is** — the one-time backfill re-fetches, dedupes, and tags previously-orphan rows where counterparty matches |
| 15 | Search across unknown-sender history | **Provider-side search button**. No rolling snapshot — auto-backfill on add captures retrospective history |
| 16 | Phase 5 scope confirmed (~3 days) | **Good — ship as-is** |
| 8b | Counterparty edge cases (group threads) | **Multi-tag**: 2+ matching recipients → save to all. 1 match + unknown others → prompt "save & add others?" with quick add. Quick-add runs the full enrichment + backfill pipeline tailored to candidate vs client classification |
| 14 | Event log TTL | **30 days** — small debug table for "where did my message go?" forensics |
| 18 | Strip quoted email replies before embedding | **Yes** — strip `>` blocks and forwarded-message headers before Voyage |
| 19 | Index call notes too | **Yes** — unified `search_communications` Joe tool covers both messages and calls |

**✅ All questions answered.** Ready to start Phase 1 (timestamps + list polish) when Chris gives the go.

---

## 1. Goals

- **Make timestamps obvious.** No more tiny "3 hours ago" in the corner. Smart formatting (`10:43 AM` / `Yesterday` / `Mon` / `May 12`) plus absolute time on hover. Date group headers in the list.
- **Email reads like email.** Outlook-style cards with `From / To / Date / Subject` headers — not chat bubbles squashing long emails.
- **Chat stays chat.** LinkedIn DMs and SMS keep conversational bubbles. The reading pane swaps layouts based on channel.
- **Workflow > passive view.** Snooze, flag, follow-up reminders, and conversation status (`Awaiting reply` / `Replied` / `Closed`) are first-class.
- **Show all messages, save the ones that matter (per channel).** Inbox shows the last 100 emails / LinkedIn DMs / Recruiter messages live from the providers. Persistence rules: **always save all SMS (in + out)** and **always save outbound** on every channel. Save **inbound email + LinkedIn** only when the sender is already a person in the CRM. When we send to someone not in the CRM, **auto-add them** with a quick Candidate/Client classifier. Adding a person triggers an **automatic backfill** of past communications from every channel. **Sent folder** in the sidebar surfaces everything we've sent across Outlook, LinkedIn, Recruiter, and SMS.
- **Saved messages AND call notes are RAG-searchable by Joe.** Every persisted message (email, LinkedIn, Recruiter, SMS) plus every AI-summarized call note gets embedded and indexed into `search_documents`. New unified Joe tool `search_communications` so he can answer questions like "who said they wanted 30% upside", "find any message about a non-compete", "did we talk to anyone about FX volumes last week".
- **Keyboard-first.** `j/k/e/r/h/#/u/?` shortcuts.
- **Better than Outlook on the things Outlook is bad at:** cross-channel unification, recruiter context sidebar, snooze/follow-up, mobile, density.

### Non-goals (this round)

- Composing from a totally new account / bulk send (sequences already cover this).
- Mailbox rules / server-side filters.
- Calendar integration changes (already shipped).

---

## 2. Current state — what's there now

Main file: `frontend/src/pages/Inbox.tsx` (1855 lines, single component). Supporting: `frontend/src/components/inbox/ComposeMessageDialog.tsx`, `UnknownPersonBadge.tsx`, `AddPersonWizard.tsx`. Data: `inbox_threads` materialized view over `conversations` + `messages`.

**Current pain points** (with file refs):

| # | Pain | Location |
|---|---|---|
| 1 | Timestamps are `text-[10px] text-muted-foreground` in top-right of each row, relative-only ("3 hours ago"). No absolute time anywhere in list. | `Inbox.tsx:201` |
| 2 | No date grouping in list (Today / Yesterday / This week). Single flat scroll. | `Inbox.tsx:1579+` |
| 3 | Chat-bubble layout used for **every** channel including long emails. Subject line buried inside the bubble. | `Inbox.tsx:1143` |
| 4 | Sender + time only show on the first message in a group. Long monologues lose context. | `Inbox.tsx:1158-1171` |
| 5 | No conversation status, no snooze, no flag, no follow-up reminders. DB has no columns for it. | `conversations` table |
| 6 | Filter pills row (All / Candidates / Contacts / Unlinked + channel icons) eats horizontal space; no real left nav. | `Inbox.tsx:1605-1654` |
| 7 | Yellow "Unlinked" badges spam every unlinked row → alert fatigue. | `Inbox.tsx:224-226` |
| 8 | Fixed 3-column desktop-only layout. No tablet/mobile collapse. | `Inbox.tsx:1296` (w-96 / w-72 etc.) |
| 9 | No keyboard navigation. | (absent) |
| 10 | **Every webhook auto-writes to `conversations` + `messages`.** 21k message rows and growing — most never linked to a candidate. | webhook handlers |

---

## 3. Architectural shift — storage strategy

**New rule (per channel):**

| Channel | Inbox display | Persistence |
|---|---|---|
| **SMS (RingCentral)** | All texts, live + persisted | **Always save** every inbound and outbound text (in and out). SMS is low-volume and high-signal — keep everything. |
| **Email (Outlook / Microsoft)** | Last **100 messages** fetched live | Save **inbound** only if sender resolves to a person in the CRM. Save **outbound (Sent)** always — every email we send from our Outlook is saved. |
| **LinkedIn DM (Unipile)** | Last **100 messages** fetched live | Save **inbound** only if sender resolves to a person in the CRM. Save **outbound** always. |
| **LinkedIn Recruiter / InMail (Unipile)** | Last **100 messages** fetched live | Save **inbound** only if sender resolves to a person in the CRM. Save **outbound** always. |

In short: **all outbound is saved. All inbound SMS is saved. Inbound email + LinkedIn is saved only when the counterparty is already a person in the CRM.**

### Why
- Outbound = our work product. Always belongs in the CRM, regardless of recipient.
- SMS = low volume, high intent (texting is rarely cold). Always save.
- Email + LinkedIn = high volume, much of it noise from unknown senders. Filter to known people.

### Recognition logic — "is the counterparty in the system?"

When a webhook fires or a live fetch normalizer runs:

1. **Email**: lookup `candidate_channels.address` or `contact_channels.address` for the inbound `sender_address`. Normalize email (lowercase, strip `+tags`).
2. **LinkedIn**: lookup `candidate_channels.provider_id` against the Unipile attendee ID / `public_identifier` / member URN.
3. **SMS**: skip the check — always save.
4. **Outbound (any channel)**: always save. If the recipient isn't a person yet → see "Auto-add on outbound" below.

If inbound + match → write to `conversations` + `messages` tagged to the resolved `candidate_id` / `contact_id`. If inbound + no match → drop the body; the live inbox UI still shows it via direct API fetch.

### Webhook handler changes (concrete)

```ts
async function handleInboundMessage(payload) {
  await supabase.from('inbox_event_log').insert({ ...metadata });

  // SMS: always save
  if (payload.channel === 'sms') {
    return await persistMessage(payload, { person: await resolveCounterparty(payload) });
    // resolveCounterparty may return null for SMS — that's OK, we still persist (untagged)
    // and surface in a "Needs classification" view so user can attach to a person.
  }

  // Email / LinkedIn / Recruiter: only save if counterparty is in the system
  const personMatch = await resolveCounterparty(payload);
  if (!personMatch) {
    return; // UI will fetch live for display
  }

  await persistMessage(payload, { person: personMatch });
}

async function handleOutboundMessage(payload) {
  // Always save. If recipient not in system, auto-create + flag for classification.
  let person = await resolveCounterparty({ ...payload, address: payload.recipient_address });
  if (!person) {
    person = await autoCreatePersonFromOutbound(payload);
  }
  await persistMessage(payload, { person });
}
```

Shared helper: `frontend/src/server-lib/resolve-counterparty.ts`.

### Auto-add on outbound — "send to someone not in the CRM"

When we send an email or LinkedIn message to someone who isn't yet a person:

1. **Auto-create** a `people` row with what we know from the outbound payload (name, email/LinkedIn URL, signature-parsed company/title if available).
2. **Add the channel** to `candidate_channels` (defaulting to candidate, see below).
3. **Mark `needs_classification = true`** on the person row.
4. **Fire `person.created`** event → triggers the auto-backfill job (catches any past history we might have with them through other channels).
5. **Toast in the UI**: "Added {Name} to CRM — classify them?" with quick buttons.

#### `needs_classification` UI

- **Sidebar view** "Needs classification" (count badge) — shows auto-added people awaiting type.
- **Inline classifier in the reading pane** when a thread is open with an unclassified person:
  ```
  ┌────────────────────────────────────────────────────────┐
  │ ⚡ Just added {Name} from this message.               │
  │   Classify them:                                       │
  │   [👤 Candidate]  [🤝 Client]  [✕ Remove]              │
  └────────────────────────────────────────────────────────┘
  ```
- **Inbox row indicator**: small `?` next to sender name on rows where the person is `needs_classification = true`.
- **Quick-classify on hover** in the thread list: hover action `📋` opens a one-click menu Candidate / Client / Remove.

Default `type = 'candidate'` on auto-add since recruiter outreach is more often to candidates than clients. User flips to `client` with one click if wrong.

### Sent folder

New sidebar item **Sent** under INBOX. Lists outbound conversations (filter: `direction = 'outbound'` on the most recent message OR conversation has an outbound message recently). Multi-channel — emails I sent through Outlook, LinkedIn messages I sent, LinkedIn Recruiter InMails, SMS I sent.

This is critical because the new rule means LinkedIn Recruiter sends, Outlook sends, etc. all live in Supabase and we want a single view of "what I've sent."

Implementation: filter on `inbox_threads` view by latest message direction = `'outbound'` (or last-outbound-from-user, scoped to current user via `owner_id`). Sort by `last_message_at DESC`.

### Outbound capture — every Sent message persists

For this to work, every send path must call `persistOutbound()`:

- **Outlook/Microsoft Graph email send** (`frontend/api/email/send.ts` or similar) — already persists for sequence-driven sends; ensure manual replies + new-compose also persist.
- **LinkedIn DM** via Unipile (`POST /chats?account_id=X`) — confirm wired.
- **LinkedIn Recruiter InMail** via Unipile — confirm wired.
- **SMS via RingCentral** — confirm wired (likely already).
- **Audit task** during Phase 5: grep every `unipile`/`microsoft`/`ringcentral` send call and verify there's a follow-on `messages` insert.

### Live inbox fetch path

For inbound from unknown senders (email + LinkedIn) **and** for any per-person communication history view:

- `GET /api/inbox/live-threads?channel=email|linkedin|recruiter&person_id=...&cursor=...&limit=100` — proxies Unipile / Microsoft Graph. Returns up to **100 messages per channel per person** (or per unknown sender if no `person_id`). **Scrollable**: cursor-based pagination — scroll past the first 100 fetches the next 100.
- React Query caches 60s; webhook tickle invalidates.
- Frontend unions persisted Supabase rows + live-API rows, dedupes by `external_conversation_id`.

SMS view doesn't need the live endpoint — it's all in Supabase.

**Inbox filters and views** (applies in every list — Focused, Other, per-person):
- **Filter by channel**: All / Email / LinkedIn / Recruiter / SMS / Calls
- **Filter by person**: typeahead picker — narrows the list to one person across all channels
- **Filter "All"**: full mixed-channel firehose, paginated/scrollable
- **Search bar**: text query against persisted bodies (Supabase) + optional "Also search inbox provider…" affordance to hit Unipile/Microsoft's search API for live results
- **Compose new**: prominent "New message" button (top-right of list) opens compose dialog with channel picker + person picker (typeahead) + rich editor. Person picker drives channel options based on what we know about them — e.g. picking Bob enables Email and LinkedIn buttons because we have both for him; SMS is disabled because no phone.

### Adding a person → cross-channel ID lookup → auto-backfill

When a person is added to the CRM (any path), we don't just backfill from the channels we already know — we **first call out to Unipile to discover all of their channel IDs across platforms**, then backfill from each.

**Multi-stage flow on `person.created`:**

**Stage 1a — LinkedIn profile fill (if LinkedIn URL present):**
1. Read what we have for the new person: `email`, `linkedin_url`, `phone`, `full_name`, `current_title`, `current_company`.
2. If `linkedin_url` is set → call `GET /api/v1/users/{public_identifier}?account_id=X` (Unipile v1) to fetch the full LinkedIn profile.
3. **Fill blank fields only** on the `people` row from the profile: `current_title`, `current_company`, `linkedin_headline`, `location`, `avatar_url`, etc. Never overwrite values the user has set.
4. Capture the LinkedIn member URN + Unipile attendee ID → upsert into `candidate_channels` / `contact_channels` (so future LinkedIn messages from them auto-recognize as hard matches).

**Stage 1b — Cross-channel ID resolution:**
1. If we still don't have LinkedIn (only an email) → try Unipile people search to find it (best-effort).
2. If LinkedIn resolves → check whether they're an existing Unipile chat attendee on any of our connected LinkedIn / Recruiter accounts; pull all known provider IDs.
3. Upsert every resolved identifier into `candidate_channels` / `contact_channels`.

**Stage 1c — Third-party enrichment for missing data (provider TBD):**
1. If after Stages 1a + 1b we're still missing key fields (e.g. no email, no phone, no company domain) → call a third-party enrichment provider. **Provider not yet selected** (candidates: Clearbit, Apollo, FullEnrich, Proxycurl). Chris will pick once we evaluate.
2. **Fill blank fields only** on the `people` row.
3. Add resolved email/phone to `candidate_channels` / `contact_channels`.
4. If the enrichment returns **multiple plausible matches** for the person → don't auto-pick. Write to `enrichment_ambiguity` table and surface in the **Data Cleanup** view for Chris to disambiguate.

**Stage 2 — Cross-channel backfill:**
1. For each channel identifier in `candidate_channels` / `contact_channels`:
   - **Email** (Microsoft Graph): query `/me/messages?$search="from:{email}" OR "to:{email}"` across Inbox + Sent.
   - **LinkedIn DM / Recruiter** (Unipile v1): `GET /chats?account_id=X` filtered to attendee = LinkedIn provider ID; then `GET /chats/{id}/messages`.
   - **SMS** (RingCentral): list messages with the matching phone number.
2. Write to `conversations` + `messages` tagged to the new person.
3. Dedupe on `external_message_id`.
4. AI-tag the backfilled messages.
5. Enqueue `messages/indexed.requested` for each backfilled row so they land in `search_documents` for Joe.

**Bounds**:
- **Email lookback: back to 2019-01-01** (anything older not pulled).
- **LinkedIn lookback: no cap** — fetch the full chat history Unipile exposes.
- **SMS lookback: no cap** — RingCentral retention is what it is.
- Toast: "Looking up {name} across channels… Backfilling past communications…"

**`last_contacted_at` / `last_responded_at` bookkeeping**: as backfill processes each message, update the `people` row:
- `last_contacted_at` = max of (existing value, every outbound message's `sent_at` to this person)
- `last_responded_at` = max of (existing value, every inbound message's `sent_at` from this person)
- `last_comm_channel` = the channel of the most recent activity in either direction
- Set in a single `UPDATE people SET last_contacted_at = greatest(...), last_responded_at = greatest(...) WHERE id = X` at the end of the backfill (not per-message — avoids 1000+ updates per person). Also recompute on the steady-state webhook insert path so the values stay fresh going forward.

**Failure mode**: partial-channel failure retries that channel; doesn't block person creation or stage 2 from running on the channels that did resolve.

#### API lookup matrix

| What we need | API | Status |
|---|---|---|
| LinkedIn profile from URL | `GET /api/v1/users/{public_identifier}?account_id=X` (Unipile) | ✅ Confirmed working (CLAUDE.md §"Confirmed v1 routes") |
| LinkedIn URL from email | `POST /api/v1/linkedin/search?account_id=X` body `{api:'recruiter', category:'people', keywords:'<email>'}` | ⏳ Needs 1-hour spike — may not always resolve |
| Email + phone from a name + company | Third-party enrichment provider | ⏳ **Provider TBD — Chris to choose** (candidates: Clearbit, Apollo, FullEnrich, Proxycurl) |
| Existing Unipile attendee on our accounts | `GET /api/v1/chats?account_id=X` filter by attendee | ✅ Confirmed working |

Add to spec once the spike confirms which calls return the IDs we need and once the third-party provider is selected.

### Sequences must stop on a reply from ANY channel

The sequence engine already detects replies cross-channel — `hasRepliedSinceEnrollment` (`frontend/src/server-lib/sequence-runner.ts:430`) queries `messages` for any inbound message tagged to the candidate/contact since enrollment, with no channel filter. **A LinkedIn reply stops an email sequence, a SMS reply stops a LinkedIn sequence, etc.**

The new storage rule must preserve this. Specifically:

1. **Anyone enrolled in a sequence is, by definition, a person in the CRM.** So their inbound replies on any channel **must** be recognized and persisted under the new recognition logic. The sequence-stop guarantee depends on this.
2. **Recognition must cover every channel identifier we know for the candidate.** Before allowing a candidate to be enrolled in a sequence, surface a warning if `candidate_channels` is missing entries for major channels we have data for (e.g. "We have a LinkedIn URL but no `candidate_channels` row for it — replies on LinkedIn won't be recognized and the sequence won't stop").
3. **Auto-populate `candidate_channels` from the people table.** If `people.email` is set but no `candidate_channels` row with `channel='email'` exists → backfill it. Same for `linkedin_url` → LinkedIn channel row, and `phone` → SMS channel row. One-time migration + a trigger so future inserts to `people` cascade.
4. **AI-fallback recognition (Phase 5+):** if an inbound message arrives that *looks* like it's from a candidate we have (matching name + company + sentiment context), but no hard channel match → attempt soft-resolution and stop the sequence with a "soft-matched reply detected" reason. Log the case; let the user confirm/reject.
5. **Connection-accepted exclusion stays** — `message_type='connection_accepted'` is already excluded from reply detection (line 439); keep that.

**Migration safety check:** when shipping Phase 5, do a one-time audit pass:
- For every active sequence enrollment, check that `candidate_channels` has rows for every channel the candidate could reply on (based on `people.email`, `people.linkedin_url`, `people.phone`). Auto-backfill missing rows; surface a report for any that couldn't be derived.

**Webhook implementation detail:** when a recognition match succeeds for an inbound, **after** persisting the message, check if the candidate has an active sequence enrollment. If yes, call the same `hasRepliedSinceEnrollment` → `stopEnrollment` path the runner uses — don't wait for the next scheduled step run to discover the reply. This makes the stop immediate rather than up-to-N-hours delayed. (May already be partially the case in `process-unipile-event.ts` / `process-microsoft-event.ts` / `process-ringcentral-event.ts` — Phase 5 audit confirms or adds it.)

Existing 10k conversations + 21k messages stay (forward-looking change). Optional later cleanup: messages where `candidate_id IS NULL AND contact_id IS NULL` AND channel ∈ (email, linkedin, linkedin_recruiter) AND older than 6 months → archive/delete. SMS rows stay regardless.

### One-time backfill on all existing people (Phase 5 launch)

When this ships, queue every existing candidate + client (~7,700 rows: 6,679 candidates + 1,062 clients) through the same two-stage `backfill-person-communications` Inngest job.

- **Reuses** the same enrichment + backfill flow as new-person creation.
- **Idempotent**: dedupes by `external_message_id` so re-running is safe.
- **Throttled**: ~5 people/sec to respect Microsoft Graph + Unipile rate limits → ~25 min wall time at the start, longer if heavy-history people queue up.
- **Sequenced per person**: Stage 1 (enrich Unipile IDs) → Stage 2 (backfill messages) → recompute `last_contacted_at` / `last_responded_at` → enqueue `messages/indexed.requested` for each row so they land in `search_documents` for Joe.
- **Resumable**: progress tracked in a new lightweight `backfill_run` table (`person_id`, `started_at`, `completed_at`, `status`, `messages_imported`, `error`) so we can pause/resume without re-scanning processed people.
- **Progress widget** in the Data Cleanup view: "4,231 of 7,741 people backfilled · 2h remaining."

### AI soft-match flow (sequence cross-channel stop)

When an inbound message arrives that does NOT hard-match a known person via `candidate_channels`:

1. Run a fast AI classifier (Joe Sonnet) comparing the inbound sender's name + email/LinkedIn handle + signature text + company context against active sequence enrollments.
2. **If soft-match confidence ≥ threshold (start at 0.85):**
   - **Stop the sequence immediately** with `stop_trigger='soft_match_reply'`.
   - **Call the enrichment API** (TBD: Unipile users lookup + optional third-party like Clearbit/Apollo) to confirm the match — pull their full identity (LinkedIn URN, official email, phone).
   - If enrichment **confirms** → **persist the new channel ID** to `candidate_channels` so future messages on this channel auto-recognize as hard matches. Update the `people` row with any new info (LinkedIn URL, etc.).
   - If enrichment **can't confirm OR returns multiple candidates** → leave the sequence stopped (better to over-stop than miss a real reply) but **send the case to Data Cleanup** for Chris to disambiguate.
3. If soft-match confidence < threshold: log the inbound to `inbox_event_log` with `soft_match_skipped` reason; don't act.

### Risk / things to watch

- **Outbound volume**: with every Outlook email persisting, the `messages` table will grow faster than today. We're OK — outbound is the highest-value data. If volume becomes an issue, archive after 24 months.
- **Auto-classification drift**: defaulting to `candidate` and relying on user to flip will drift toward incorrect classification. Counter: surface "Needs classification" prominently in sidebar; consider an AI guess based on signature parsing (e.g. if signature says "Director of Talent at X" → likely client).
- **Backfill from auto-add**: when an outbound to a new email triggers auto-add → backfill might pull months of past back-and-forth. That's the goal but verify it doesn't surprise users (toast count helps).
- **Search across history**: inbound from unknown senders isn't searchable inside Sully (only the provider's search). Acceptable trade-off.
- **Counterparty edge cases**: forwarded emails, group threads, dist lists. Rule: if ANY counterparty matches a person, persist tagged to that person. If multiple match, pick the first.

---

## 4. UI redesign

### 4.1 New layout — 4 zones

```
┌──────────┬────────────────────┬──────────────────────────┬──────────┐
│ Sidebar  │   Thread list      │   Reading pane           │ Entity   │
│ (~200px) │   (~360px)         │   (flex-1)               │ (~280px) │
│          │                    │                          │ toggle   │
│ Inbox 12 │  ┌ Focused │Other┐ │  ┌ Subject line (bold) ┐ │ Linked   │
│ Unread 4 │  │  ───────────── │ │  │ Bob Smith           │ │ candidate│
│ Starred  │  │  ▎Bob Smith    │ │  │ Awaiting reply · 📧 │ │ card     │
│ Snoozed  │  │   Re: Q3 role  │ │  └─────────────────────┘ │          │
│ Sent     │  │   "Thanks…"    │ │                          │ Avatar   │
│ Drafts   │  │   10:43 AM ⚑⏰☐│ │  ┌ Bob Smith            ┐ │ Name     │
│ Archive  │  │                │ │  │ To: chris@em…        │ │ Title    │
│ ──────── │  │  ── Today ──   │ │  │ May 14, 3:42 PM      │ │ Co.      │
│ Email    │  │  ▎Jane Doe     │ │  │                      │ │ ──────── │
│ LinkedIn │  │   ...          │ │  │ <email body>         │ │ Recent   │
│ SMS      │  │                │ │  └──────────────────────┘ │ notes    │
│ Recruiter│  │  ── Yesterday ─│ │                          │          │
│ ──────── │  │   ...          │ │  ┌ Quick reply        ┐  │          │
│ Tags     │  │                │ │  │ [rich editor]      │  │          │
│ Settings │  │  ── This week ─│ │  └────────────────────┘  │          │
└──────────┴────────────────────┴──────────────────────────┴──────────┘
```

- **Sidebar (left, 200px)** — primary nav. Replaces filter pills row.
- **Thread list (360px)** — Focused / Other tabs at top.
- **Reading pane (flex-1)** — channel-aware layout.
- **Entity panel (280px, toggle)** — collapsed by default below 1280px.

Below `lg` (1024px): collapse to single column with breadcrumb (Inbox → Thread → Person), entity panel as a slide-over.

### 4.2 Sidebar nav

```
INBOX
  All
  Unread             (count badge)
  Starred
  Snoozed            (count + soonest wake)
  Awaiting reply     (count)
  Sent               ← all outbound across channels
  Drafts
  Archive
  Needs classification (count) ← auto-added people waiting for type
─────
CHANNELS
  📧 Email
  💼 LinkedIn
  🎯 Recruiter
  💬 SMS
─────
SAVED VIEWS  (e.g. "Unanswered LinkedIn this week")
  + Add view
─────
SETTINGS
```

- All sections are filters; clicking sets a URL state (`?view=unread&channel=email`).
- Saved views are user-defined combinations (channel + status + age + assignee).
- Pinned channels light up when there's unread. Tiny dot, not a number, to reduce visual noise.

### 4.3 Thread list — row redesign

```
┌──────────────────────────────────────────────────────────────┐
│ ▎ ◯  Bob Smith                       10:43 AM    ⚑ ⏰ ✉ 🗄  │  ← actions on hover
│      Re: Q3 Engineering Director role                        │
│      Hi Chris — thanks for the intro to the team last week…  │
│      [📧]  [Awaiting reply]                              📎  │
└──────────────────────────────────────────────────────────────┘
```

Anatomy (top to bottom, left to right):
- **▎** unread accent bar (4px wide, full row height, accent color). Replaces background tint.
- **◯** selection checkbox (visible on row hover OR when any row selected, like Outlook).
- **Sender name** — `text-sm font-semibold` if unread, `font-normal` if read.
- **Timestamp** — `text-xs font-medium` (not `text-[10px] text-muted`). Smart format. **Tooltip** on hover shows `Tuesday, May 14, 2026 at 10:43 AM`.
- **Hover actions** (right side, only on hover): flag `⚑`, snooze `⏰`, mark unread `✉`, archive `🗄`. Disappear when not hovered.
- **Subject line** (second row) — `text-sm font-semibold` if unread, `font-medium` if read. Single line, ellipsis.
- **Preview** (third row) — `text-xs text-muted-foreground`, two lines max with line-clamp.
- **Bottom row** — channel icon pill + status pill + attachment indicator. No "Unlinked" yellow badge here (moved to a quieter signal — see 4.6).

#### Density toggle (`Comfortable / Compact`)

- Comfortable: as drawn above, ~88px tall per row.
- Compact: subject + preview collapse onto one line, row height ~56px.
- Toggle in sidebar footer; persisted in `localStorage`.

### 4.4 Smart timestamp formatter

Add `frontend/src/lib/format-time.ts`:

```ts
// Pseudocode
function formatSmartTimestamp(ts: Date, now = new Date()): string {
  if (diffMin(now, ts) < 1) return "Just now";
  if (isSameDay(now, ts)) return format(ts, "h:mm a");          // 10:43 AM
  if (isYesterday(now, ts)) return "Yesterday";
  if (diffDays(now, ts) < 7) return format(ts, "EEE");           // Mon
  if (isSameYear(now, ts)) return format(ts, "MMM d");           // May 12
  return format(ts, "MMM d, yyyy");                              // May 12, 2025
}

function formatAbsoluteTimestamp(ts: Date): string {
  return format(ts, "EEEE, MMMM d, yyyy 'at' h:mm a");
}
```

Used in:
- Thread list row timestamp (with tooltip = absolute).
- Reading pane message header (visible + tooltip).
- Date separators in thread.

### 4.5 Date group headers in thread list

Sticky headers as you scroll:

```
─── Today ────────────────────
  [3 threads]
─── Yesterday ────────────────
  [5 threads]
─── This week ────────────────
  [12 threads]
─── Earlier this month ───────
  [n threads]
─── May ──────────────────────
  [n threads]
─── 2025 ─────────────────────
```

Use a virtual list (e.g. `react-virtuoso` — already in `package.json` if not, easy add) for performance once we exceed a few hundred rows.

### 4.6 Status / unlinked treatment

- **Status pill on each row**: `Awaiting reply` (gray), `Replied` (green), `Snoozed` (purple + wake time), `Closed` (muted), `Pinned` (gold). Replaces the "Unlinked" yellow badge as the primary status signal.
- **Unlinked indicator**: small `?` icon next to sender name on rows where no person is linked — quieter than the yellow badge. Hover shows "Click to link a person."

### 4.7 Reading pane — channel-aware

#### Email layout (better than Outlook)

```
┌────────────────────────────────────────────────────────────┐
│ ◄ Back        Re: Q3 Engineering Director role             │   ← sticky subject header
│               Awaiting reply · linked: Bob Smith            │
│                                                            │
│  ─── Message thread ───                                    │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Bob Smith <bob@acme.com>                             │  │   ← latest, expanded
│  │ To: chris@emeraldrecruit.com    May 14, 3:42 PM (2h) │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ Hi Chris,                                            │  │
│  │                                                      │  │
│  │ Thanks for the intro to the team last week. We're    │  │
│  │ planning to move forward — can you send over the    │  │
│  │ standard contract?                                   │  │
│  │                                                      │  │
│  │ Best,                                                │  │
│  │ Bob                                                  │  │
│  │                                                      │  │
│  │ 📎 contract-draft.pdf (240 KB)                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Chris (you) → Bob       May 12, 10:14 AM ▼ collapsed │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Bob Smith → Chris       May 11, 4:21 PM   ▼ collapsed│  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ─── Quick reply ───                                       │
│  [rich text editor]   [Send] [Save draft] [Cancel]         │
└────────────────────────────────────────────────────────────┘
```

Key wins over Outlook:
- **Sticky context header** (subject + status + linked person) stays visible while scrolling — Outlook loses this.
- **Time-since on each header** (`May 14, 3:42 PM (2h)`) — Outlook only shows the absolute time.
- **One-click collapse** of older messages; latest auto-expanded.
- **Inline rich-reply** at bottom of pane (no separate window). Templates picker, attachments, AI-draft button (`Joe`).
- **Recruiter context strip** above subject when a candidate is linked: avatar + name + current pipeline stage + last activity. Outlook has nothing like this.

#### Chat layout (LinkedIn DMs / SMS)

Keep current bubbles, but with:
- **Sticky subject header** at top (or sender name + channel for chat).
- **Every** message shows time inline (drop the "first in group only" rule).
- Time format: `10:43 AM` for today, `Yesterday 10:43 AM` for yesterday, `Mon 10:43 AM` for this week, `May 12, 10:43 AM` for older.
- Hover any bubble → tooltip with absolute timestamp.
- **Date dividers** as today, but using smart format (`Today`, `Yesterday`, then `Monday, May 12`).

#### Recruiter context strip (both layouts)

When the thread is linked to a candidate or client:

```
┌────────────────────────────────────────────────────────┐
│ 👤 Bob Smith · Senior PM at Acme · Pipeline: Submission│
│    Last activity: Send-out sent 3 days ago             │
└────────────────────────────────────────────────────────┘
```

This is the recruiter-specific feature Outlook can't touch.

### 4.8 Snooze / flag / follow-up

- **Snooze (⏰)**: opens a small popover with `Later today (3 PM) / Tomorrow morning (8 AM) / This weekend / Next week / Custom...`. Sets `snoozed_until`; thread disappears from inbox until wake time.
- **Flag (⚑)**: toggles `flagged = true`. Flagged view in sidebar.
- **Follow-up reminder**: per-thread option "Remind me if no reply by ___". Inngest job checks daily and resurfaces the thread (with a banner "No reply yet — set this reminder N days ago").
- **Status**: derived where possible (`Awaiting reply` if outbound was last, `Replied` if inbound was last after our outbound). Manually closable.

### 4.9 Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / prev thread |
| `Enter` | Open thread |
| `Esc` | Close thread |
| `e` | Archive |
| `#` | Delete |
| `r` | Reply |
| `R` | Reply all |
| `f` | Forward |
| `h` | Snooze (opens menu) |
| `s` | Star/flag |
| `u` | Mark unread |
| `Shift+u` | Mark read |
| `/` | Focus search |
| `c` | Compose new |
| `g i` | Go to Inbox |
| `g u` | Go to Unread |
| `g s` | Go to Snoozed |
| `?` | Show shortcut cheat sheet |

Implement via `useHotkeys` (or a small handler on the inbox page). Cheat-sheet overlay with `cmdk` (already in repo? if not, basic dialog).

### 4.10 Search

- Top-of-list search box: searches **across all visible (promoted) threads** by sender, subject, body.
- For broader search across non-persisted (live) inbox: separate "Search inbox provider…" button that hits Unipile's search API and surfaces results — clearly marked "Not saved in Sully."
- Filters: `from:bob@acme.com`, `channel:linkedin`, `has:attachment`, `is:unread`, `is:flagged`, `before:2026-05-01`.

### 4.11 Bulk actions

- Cleaner toolbar (top of list, slides down when 1+ selected):
  - Mark read/unread, snooze, archive, delete, move to view, assign to teammate.
- "Select all in view" link in the toolbar (cap at 200 to avoid runaway).

### 4.12 Mobile

Below `lg` (1024px):
- Sidebar → hamburger menu drawer.
- 3-pane → stack: List view → tap row → Thread view (back button) → tap "Person" → Entity slide-over.
- Quick actions become swipe gestures (swipe left = archive, swipe right = snooze).

### 4.13 Data Cleanup — new Settings view

A new page at `/settings/data-cleanup` (or `/admin/data-cleanup`) that unifies every "this needs your attention" data hygiene case in one place. Replaces / absorbs the existing `frontend/src/pages/CollisionReview.tsx`.

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings › Data Cleanup                                        │
│                                                                 │
│  Backfill progress: 4,231 of 7,741 people · 2h remaining        │
│  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░  54%                  │
│                                                                 │
│  ┌──────────────┬─────────────┬─────────────┬──────────────┐    │
│  │ Needs        │ Enrichment  │ Duplicates  │ Missing      │    │
│  │ classification│ ambiguous   │             │ channel data │    │
│  │  (12)        │  (7)        │  (23)       │  (89)        │    │
│  └──────────────┴─────────────┴─────────────┴──────────────┘    │
│                                                                 │
│  ─── Needs classification (12) ─────────────────────────        │
│  Jane Doe — sent via Outlook 3 hrs ago                          │
│    Suggested by AI: Candidate (0.92 confidence)                 │
│    [✓ Accept]  [👤 Candidate]  [🤝 Client]  [✕ Remove]          │
│  ────────────────────────────────────────────                   │
│  …                                                              │
│                                                                 │
│  ─── Enrichment ambiguous (7) ──────────────────────────        │
│  Mark Johnson — enriched: 3 possible LinkedIn matches           │
│    [Mark Johnson, Senior PM at Citadel]  [Select]               │
│    [Mark Johnson, MD at Goldman Sachs]   [Select]               │
│    [Mark Johnson, Partner at Apollo]     [Select]               │
│  …                                                              │
│                                                                 │
│  ─── Duplicates (23) ───────────────────────────────────        │
│  (existing CollisionReview UI surfaces here — merge action)     │
│                                                                 │
│  ─── Missing channel data (89) ─────────────────────────        │
│  Bob Smith — has email, no LinkedIn URL                         │
│    [🔍 Run enrichment]  [Skip]                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Four sections:**

1. **Needs classification** — people auto-added from outbound sends (`needs_classification=true`). Shows AI-guessed type + confidence. Quick-classify buttons.
2. **Enrichment ambiguous** — when our Unipile/third-party lookup returned multiple plausible matches for a person, surface them here for manual pick. Triggered by add-person, sequence enrollment, or soft-match flow.
3. **Duplicates** — existing `CollisionReview.tsx` UI absorbed as a tab. Detect overlapping records by email/LinkedIn URL/phone. Merge action consolidates.
4. **Missing channel data** — people with sparse channel coverage (e.g. has email + name but no LinkedIn URL). Click "Run enrichment" to fill on demand. Bulk action: "Enrich all" runs the API in batch.

**Counts as badge in main app nav** so the user notices when cleanup is needed.

**Permissions**: admin-only for now (Chris is admin; Ashley + Nancy see read-only).

---

## 5. Data model changes

### 5.1 New columns on `conversations`

```sql
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IS NULL OR status IN ('awaiting_reply','replied','snoozed','closed','no_reply_needed'));

CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_until ON public.conversations(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_flagged ON public.conversations(flagged)
  WHERE flagged = true;

CREATE INDEX IF NOT EXISTS idx_conversations_status ON public.conversations(status)
  WHERE status IS NOT NULL;
```

### 5.1b New column on `people` — needs_classification

```sql
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS needs_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_added_source text;  -- 'outbound_email'|'outbound_linkedin'|'outbound_recruiter'|...

CREATE INDEX IF NOT EXISTS idx_people_needs_classification ON public.people(needs_classification)
  WHERE needs_classification = true;
```

Note: `people.type` keeps its existing `CHECK (type IN ('candidate','client'))` constraint. Auto-added people default to `type = 'candidate'` + `needs_classification = true`. User confirms or flips type, which clears the flag. No need to extend the CHECK constraint or touch the candidate/client filters elsewhere in the app.

### 5.1c New `backfill_run` table — tracks one-time + per-person backfill

```sql
CREATE TABLE public.backfill_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES public.people(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('person_created','one_time_existing','manual_retry')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','enriching','backfilling','indexing','complete','partial','failed')),
  started_at timestamptz,
  completed_at timestamptz,
  messages_imported int DEFAULT 0,
  channels_enriched text[] DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.backfill_run (status, created_at) WHERE status != 'complete';
CREATE INDEX ON public.backfill_run (person_id, created_at DESC);
```

### 5.1d New `enrichment_ambiguity` table — feeds the Data Cleanup view

```sql
CREATE TABLE public.enrichment_ambiguity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('person_created','soft_match','manual')),
  candidates jsonb NOT NULL,    -- [{ name, linkedin_url, title, company, source_provider, confidence }, ...]
  resolved_choice jsonb,        -- the chosen item once user picks; NULL until resolved
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.enrichment_ambiguity (person_id) WHERE resolved_at IS NULL;
```

### 5.2 New `inbox_event_log` (lightweight webhook trace, 7-day TTL)

```sql
CREATE TABLE public.inbox_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  external_message_id text,
  external_conversation_id text,
  account_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  promoted boolean NOT NULL DEFAULT false,
  promoted_at timestamptz,
  promoted_conversation_id uuid REFERENCES public.conversations(id)
);

CREATE INDEX ON public.inbox_event_log (received_at);
-- Cron: DELETE FROM inbox_event_log WHERE received_at < now() - interval '7 days';
```

### 5.3 New `inbox_saved_views`

```sql
CREATE TABLE public.inbox_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { channel, status, has_attachment, age_days, assignee_id, ... }
  sort_order int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inbox_saved_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own their saved views" ON public.inbox_saved_views
  FOR ALL TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
```

### 5.4 `inbox_threads` view changes

Refactor the materialized view to:
- Union persisted conversations (`is_persisted=true`) with live API results in the frontend, NOT in the view.
- Or: keep view as today but add `snoozed_until`, `flagged`, `status`, `follow_up_at` columns from `conversations` so the list query returns them.

Recommendation: leave the view; frontend merges live + persisted at query layer (React Query).

### 5.5 Webhook handlers — promote-or-drop logic

Pseudocode for `frontend/api/webhooks/unipile-events.ts` (and similar):

```ts
async function handleInboundMessage(payload) {
  // 1. Always log
  await supabase.from('inbox_event_log').insert({ ...metadata });

  // 2. Look up if conversation is already persisted
  const existing = await supabase
    .from('conversations')
    .select('id, is_persisted')
    .eq('external_conversation_id', payload.external_conversation_id)
    .maybeSingle();

  if (existing?.is_persisted) {
    // Append the message to existing thread
    await supabase.from('messages').insert({...});
    return;
  }

  // 3. Otherwise: check AI signals (high-confidence positive_response etc.)
  const aiTags = await classifyMessage(payload);   // existing path
  if (aiTags.some(t => HIGH_SIGNAL_TAGS.includes(t))) {
    await promoteConversation(payload, 'ai_signal');
    return;
  }

  // 4. Otherwise: DROP (don't write to messages/conversations)
  //    The frontend will fetch from Unipile live when user opens inbox.
}
```

`promoteConversation()` is a new helper that creates the conversation row + persists the thread snapshot (calls Unipile to backfill thread history).

---

## 6. Implementation phases

Sized so each PR is reviewable on its own. Roughly 2-3 weeks of work end-to-end.

### Phase 1 — Timestamp + list polish (no DB changes, ~2 days)

Files:
- `frontend/src/lib/format-time.ts` (new) — `formatSmartTimestamp`, `formatAbsoluteTimestamp`.
- `frontend/src/pages/Inbox.tsx:114-232` — replace `ThreadItem`:
  - Smart timestamp + tooltip.
  - Accent-bar unread style.
  - Bigger sender/subject typography.
  - Hover actions row (flag/snooze/archive UI only — wired in Phase 4).
- `frontend/src/pages/Inbox.tsx:1108-1115` — date separator uses smart format.
- Add date group headers in the list (Today / Yesterday / This week / etc.).
- Density toggle (localStorage).

### Phase 2 — Sidebar nav + Focused/Other tabs (~2 days)

Files:
- `frontend/src/components/inbox/InboxSidebar.tsx` (new).
- `frontend/src/pages/Inbox.tsx` — replace filter pills row with sidebar layout. Move channel filters into sidebar.
- Wire URL state (`?view=unread&channel=email`).
- Focused vs Other tab on the list.

### Phase 3 — Reading pane redesign (~3 days)

Files:
- `frontend/src/components/inbox/EmailThread.tsx` (new) — Outlook-card layout.
- `frontend/src/components/inbox/ChatThread.tsx` (new) — extract current bubble layout, polish.
- `frontend/src/components/inbox/RecruiterContextStrip.tsx` (new).
- `frontend/src/pages/Inbox.tsx` — switch on channel to render EmailThread vs ChatThread.
- Sticky subject header in both layouts.

### Phase 4 — Snooze / flag / status + workflow (~4 days, includes migration)

Files:
- New migration `frontend/supabase/migrations/<date>_inbox_workflow_columns.sql` — adds the columns from §5.1.
- `frontend/src/components/inbox/SnoozeMenu.tsx`, `FollowUpMenu.tsx`.
- Wire hover actions in `ThreadItem` to real handlers.
- Sidebar views for Snoozed, Flagged, Awaiting reply.
- Inngest function to resurface follow-up reminders.
- Status auto-derivation (`awaiting_reply` / `replied`) on every new inbound/outbound.

### Phase 5 — Person-based persistence + Sent folder + auto-add + backfill (~3 days, revised)

**Audit (2026-05-24) revealed most of the plumbing already exists.** What's already built vs what we need:

**✅ Already works (no change needed):**
- **All outbound persists.** Sequence sends (`sequence-runner.ts:385`), manual sends from inbox (`api/lib/inngest/functions/send-message.ts:80`). Every channel — Outlook email, LinkedIn DM, LinkedIn Recruiter InMail, RingCentral SMS — already writes to `messages` with `direction='outbound'`.
- **Webhooks call `stopEnrollment()` immediately on a recognized inbound reply.** All four handlers (`process-unipile-event.ts:362` email, `:612` LinkedIn; `process-microsoft-event.ts:591`; `process-ringcentral-event.ts:152`) already match the candidate and call `stopEnrollment(supabase, enrollment, "reply_received", ...)`. No waiting for the next step run. **Cross-channel reply stop already works in production.**
- **Person-created → backfill is already wired.** Supabase trigger → `api/webhooks/person-created.ts:142` fires `messages/fetch-entity-history.requested` Inngest event on any insert into `people`. This is the backfill we wanted.
- **Backfill jobs exist**: `api/lib/inngest/functions/fetch-entity-history.ts`, `backfill-emails.ts`, `backfill-linkedin-messages.ts`.
- **SMS always persists**: RingCentral webhook (`process-ringcentral-event.ts:112`) inserts every inbound SMS regardless of recognition.
- **Inbound email/LinkedIn already match by email/provider_id**, not by `candidate_channels` row existence — so recognition works even when channel rows are missing.

**⚠️ Currently broken vs the new rule (must change):**
- **Inbound LinkedIn from unknown senders is currently persisted** at `process-unipile-event.ts:494` (the "linkedin unlinked inbound" path) with `candidate_id=NULL` + `contact_id=NULL`. **This is exactly what the new rule says to stop doing.** Phase 5 must gate this insert behind the recognition check.
- **Inbound email from unknown senders**: similar — check `process-unipile-event.ts:311` and `process-microsoft-event.ts:527` for the same drop-on-no-match gate.

**🔨 Net new work for Phase 5:**

1. **Gate inbound persistence** — in `process-unipile-event.ts` and `process-microsoft-event.ts`, wrap the email + LinkedIn insert in a recognition check; drop if no match. Leave SMS path alone (always persists). **~3 hours.**
2. **Live-fetch endpoint** `api/inbox/live-threads.ts` — proxy Unipile + Microsoft, return last 100 threads per channel for the "Other" view. **~1 day.**
3. **Auto-add on outbound to unknown recipient** — in the manual send path (`send-message.ts`), if `resolveCounterparty(recipient)` returns null, call new `autoCreatePerson()` helper before persisting. Already wired for sequences? **Audit and confirm.** Default `type='candidate'`, `needs_classification=true`, fires `person.created` (which already triggers backfill). **~half day.**
4. **`needs_classification` migration** + sidebar view + inline classifier banner in reading pane. **~half day.**
5. **Sent folder view** — UI only. Filter `inbox_threads` by latest message `direction='outbound'`, scoped to current user via `owner_id`. **~half day.**
6. **`candidate_channels` auto-sync** — Postgres trigger (or Inngest job on person update) that creates channel rows when `people.email` / `linkedin_url` / `phone` are set/changed. Improves backfill completeness; not strictly required since webhooks match by email/provider_id directly. **~half day.**
7. **(Optional) Centralized `persistMessage()` helper** — 13 hand-rolled `.from("messages").insert()` sites today, with slight field drift between them (`unipile_message_id` set in some, not others, etc.). Pull into a single helper. Reduces long-term bug surface but not required for the redesign. **~1 day if we do it.**

**Removed from Phase 5 because already done:**
- ~~Audit every send endpoint to ensure outbound persistence~~ — confirmed all 4 channels persist.
- ~~Wire `stopEnrollment` from webhook handlers~~ — confirmed all 4 webhooks already do this immediately.
- ~~Build the Inngest backfill job~~ — `fetch-entity-history.ts` + `backfill-emails.ts` + `backfill-linkedin-messages.ts` already exist and are triggered by the person-created webhook.
- ~~Wire `person.created` event from every create path~~ — Supabase trigger covers every insert into `people` regardless of code path.

**Pre-Phase-5 verification (one-line tasks):**
- Confirm `PERSON_CREATED_WEBHOOK_SECRET` env var is set in production so the trigger → webhook → backfill chain actually fires.
- Spot-check that `fetch-entity-history.ts` respects the 24-month lookback we want (or set it).

**Revised effort: ~3 days** (down from the original 5).

### Phase 6 — Keyboard shortcuts + cheat sheet (~1 day)

Files:
- `frontend/src/lib/inbox-hotkeys.ts` (new).
- `frontend/src/components/inbox/ShortcutCheatSheet.tsx` (new).

### Phase 7 — Mobile responsive (~2 days)

- Breakpoint-based layout collapse.
- Swipe gestures (using `react-swipeable` or similar).

### Phase 8 — Search + saved views polish (~2 days)

- Search operators (`from:`, `channel:`, `has:attachment`, etc.).
- Saved view CRUD UI.
- Optional: live-provider search (Unipile search API surfaced separately).

### Phase 9 — Index persisted messages for RAG / Ask Joe (~2 days)

**Goal**: every message we save to `messages` becomes searchable by Joe via semantic + keyword search. Today Joe can list recent messages per candidate (`list_recent_communications`) but **cannot semantically search message bodies** — he can't answer "find the candidate who said they wanted 30% upside" or "who mentioned a non-compete recently."

**Live state of `search_documents` (verified via DB query, 2026-05-24):**

| source_kind | rows | with embedding |
|---|---|---|
| candidate | 6,679 | 100 |
| **message** | **4,607** | **100** |
| contact | 1,062 | 98 |
| company | 526 | 100 |
| resume | 186 | 93 |
| call | 99 | 99 |
| job | 38 | 38 |
| send_out | 15 | 15 |
| note | 4 | 4 |

**Diagnosis**: a one-shot batch in **April 2026** populated 4,607 message rows (subject as `title`, "EMAIL | outbound | Chris Sullivan" as `subtitle`, body as `body`, metadata json with channel/direction/sent_at/conversation_id). **No code in the current repo writes to `search_documents`** — the populator was likely a deleted/manual script. ~98% of the rows have NO embedding. **No new messages have been indexed since April 2026** — meaning ~16k messages from the last ~5 weeks aren't even in `search_documents`, and the 4,607 that are have no vectors. The Joe RPCs (`match_search_documents`, `search_search_documents`) exist and are correct — they're just unused for messages because the data isn't there.

**Existing infrastructure (correct, ready to use):**
- `search_documents` table with `embedding vector`, `fts tsvector` (generated column, weighted title/subtitle/body), person/candidate/contact tagging, metadata jsonb.
- RPCs `match_search_documents(query_embedding, filter_kinds, match_count, min_similarity)` and `search_search_documents(search_query, filter_kinds, match_count)`.
- Voyage Finance-2 embedding helper in `supabase/functions/ask-joe/index.ts:157` (`embedQuery()`).

**Work to do:**

1. **New indexer helper** `frontend/src/server-lib/index-message.ts` — given a `messages` row, build the doc shape and upsert into `search_documents`:
   ```ts
   {
     source_kind: 'message',
     source_id: message.id,
     person_id: message.candidate_id ?? message.contact_id,
     candidate_id: message.candidate_id,
     contact_id: message.contact_id,
     title: `${direction === 'outbound' ? 'To' : 'From'} ${counterpartyName} · ${channelLabel}`,
     subtitle: message.subject ?? null,
     body: stripQuotedAndHtml(message.body),   // dequote replies, strip HTML, cap at 8KB
     metadata: { channel, direction, sent_at, conversation_id, attachments_count, ai_tags },
     source_updated_at: message.sent_at ?? message.received_at,
     embedding: await embedVoyage(combinedText),   // title + subtitle + body, capped
   }
   ```

2. **Trigger on persistence** — call `indexMessage()` from the (new or existing) `persistMessage()` helper, right after the `messages` insert. Fire as an Inngest job (`messages/indexed.requested`) so the embed API call doesn't block the webhook response.

3. **Two-step backfill** (because of the half-built state):
   - **Step A — Index the missing rows**: `backfill-message-search-documents.ts` Inngest fn pages through `messages` where `id NOT IN (SELECT source_id::uuid FROM search_documents WHERE source_kind='message')`. Upserts the doc shape. **~16k+ rows** since the April 2026 batch.
   - **Step B — Embed the unembedded rows**: separate `backfill-message-embeddings.ts` pages through `search_documents WHERE source_kind='message' AND embedding IS NULL`. Embeds the combined title+subtitle+body and writes. **~21k rows total** after step A. ~$2.50 one-time at Voyage Finance-2 pricing ($0.00012/1K tokens × ~200 tokens/msg). Throttled to 50 req/sec → ~7 minutes wall time.
   - Both jobs are idempotent and resumable; can be run in either order (the embedder skips rows already with embedding).

4. **Delete on message delete** — when a `messages` row is deleted (rare; archive-then-delete), cascade-delete the `search_documents` row by `source_id`. Add a Postgres trigger or include it in the delete helper.

5. **New Joe tool** `search_communications` in `supabase/functions/ask-joe/index.ts`:
   ```
   name: "search_communications",
   description: "Semantic + keyword search across saved messages and call notes
                (emails, LinkedIn DMs, Recruiter InMails, SMS, phone calls).
                Returns excerpts plus the person, channel, direction, and date.
                Use to answer 'who said X', 'find any message or call about Y',
                'when did they mention Z'."
   input: { query: string, person_id?: uuid, channel?: string, direction?: string,
            kinds?: ['message'|'call'] (default both), since?: date,
            limit?: int (default 8) }
   ```
   Calls existing `match_search_documents(filter_kinds=['message','call'], ...)` (vector) and `search_search_documents(filter_kinds=['message','call'], ...)` (FTS via the `fts` generated column), then reciprocal-rank-fusion merges in JS — same pattern as `search_people` today. No new RPC strictly required.

6. **Joe system prompt update** — add `search_communications` to the tools list and a one-line hint: "Use `search_communications` for questions about what someone said, agreed to, complained about, asked for, talked about on a call, etc."

7. **Also index calls** — same April 2026 one-shot batch indexed 99 call rows (all embedded) but no calls have been indexed since. Live state: 525 total `call_logs`, 331 `ai_call_notes` (Deepgram-generated summaries), only **99 in `search_documents`** (a ~70% gap). Build the same per-persistence indexer for `ai_call_notes` insert → `search_documents` row with `source_kind='call'`. Body = the AI-generated call summary; title = candidate/contact name + phone; subtitle = direction + timestamp. Reuse the same backfill pattern (two-step: missing rows, then missing embeddings).

**Unified Joe tool**: instead of separate `search_messages` and `search_calls` tools, name it **`search_communications`** and have it cover both — `filter_kinds=['message', 'call']` by default, optional `kinds` arg to restrict. Joe doesn't need to know the distinction unless asked.

**Privacy / scope note:**
- Only messages already persisted under the new storage rule get indexed (i.e. tagged to a person in the CRM). Unrecognized inbound is never embedded.
- Outbound is always indexed (it's always persisted under the new rule).
- SMS always indexed (it's always persisted).
- Calls: every `ai_call_notes` row indexed (calls are already always tagged to a person via `candidate_id` / `contact_id` on the call_logs row).
- RAG search scope = every persisted message body + every AI call summary.

**Cost:**
- Voyage Finance-2 embeddings: ~$0.00012 per 1K tokens. Typical message ~200 tokens, typical call note ~400 tokens.
- Backfill: ~21k messages + ~331 ai_call_notes ≈ ~$3.00 one-time.
- Steady state at ~50 saved messages/day + ~3 calls/day: ~$0.15/year. Negligible.

**Files:**
- `frontend/src/server-lib/index-communication.ts` (new) — shared indexer helper used for both messages and call notes. Builds doc + calls Voyage embed in one go.
- `frontend/api/lib/inngest/functions/index-communication.ts` (new) — Inngest wrapper. Handles `messages/indexed.requested` + `calls/indexed.requested` events.
- `frontend/api/lib/inngest/functions/backfill-communication-search-documents.ts` (new) — Step A backfill (missing rows, both kinds).
- `frontend/api/lib/inngest/functions/backfill-communication-embeddings.ts` (new) — Step B backfill (missing embeddings, both kinds).
- `frontend/supabase/functions/ask-joe/index.ts` — add `search_communications` tool + handler (filter_kinds=['message','call']).
- Update `persistMessage()` helper (or the 13 insert sites) to enqueue `messages/indexed.requested`.
- Add similar enqueue on `ai_call_notes` insert (likely in `call-deepgram-runner.ts` or wherever the AI summarization writes the row) — enqueue `calls/indexed.requested`.
- Tweak `BASE_SYSTEM_PROMPT` in ask-joe to mention `search_communications`.

**Effort revision: ~3.5 days** (was ~3). The +0.5 day covers the call indexer + ai_call_notes backfill (most logic shared with messages via the unified `index-communication.ts`).

---

## 7. Open questions for Chris

1. ✅ **Live-fetch cap** — **answered**: 100 per channel per person, scrollable, filterable.
2. ✅ **Auto-add default type** — **answered**: AI-guess.
3. ✅ **Deny-list** — **answered**: yes.
4. ✅ **AI-guess classification** — **answered**: yes (same as #2).
5. ✅ **Backfill lookback window** — **answered**: email **back to 2019**; LinkedIn **forever** (no cap).
6. ✅ **Backfill on existing people** — **answered**: yes, one-time backfill on all existing candidates/clients across sent + received. **Plus**: backfill must accurately populate `people.last_contacted_at` and `people.last_responded_at` as it goes.
7. ✅ **AI tagging on non-persisted inbound** — **answered**: **skip** to save cost. The one-time backfill (Q8) will re-run AI tags on previously-unknown messages once the person is added.
8. ✅ **Counterparty edge cases (group threads, forwards, dist lists)** — **answered**: **multi-tag**. If 2+ recipients match known people, save the conversation tagged to ALL of them. If only 1 matches and the others are unknown, surface a "Save & add the other recipients?" prompt with quick add buttons. **Quick-adding an unknown recipient runs the full add-person enrichment pipeline** (Stages 1a–1c + Stage 2 backfill) tailored to whatever the AI-classify (or user-confirm) says they are — candidate vs client.
9. ✅ **Default density** — **answered**: Comfortable (Claude's call).
10. ✅ **Focused vs Other criteria** — **answered**: yes, persisted vs live unknown.
11. ✅ **Snooze wake notification** — **answered**: **push notification** when a snoozed thread wakes.
12. ✅ **Search across unknown-sender history** — **answered**: provider-side search button. No rolling snapshot needed — auto-backfill on add captures retrospective history.
13. ✅ **Existing 21k messages cleanup** — **answered**: **leave as-is**. The one-time backfill (Q8) re-fetches from providers and dedupes; previously-orphan rows get tagged when their counterparty turns out to be a now-known person.
14. ✅ **Event log TTL** — **answered**: yes to the small debug table, **30 day TTL**.
15. ✅ **Audit scope for outbound persistence** — **answered (separately)**: audit complete. Outbound persists across all paths; cross-channel `stopEnrollment` already wired; person-created → backfill chain already exists. Phase 5 shrinks to ~3 days.
16. ✅ **Sequence cross-channel AI soft-match** — **answered**: yes, **stop the sequence on soft-match AND run the enrichment API to confirm**. On confirmed match, persist the new channel ID to `candidate_channels` so the next message recognizes hard. On enrichment fail or low confidence, surface in **Data Cleanup**.
17. ✅ **Pre-enrollment warning** — **answered**: don't warn — instead **auto-run enrichment** to fill missing channel data (e.g. enroll an email-only candidate → silently enrich for LinkedIn). If enrichment returns **multiple candidates / ambiguous match**, add the case to a new **Data Cleanup** Settings view for manual disambiguation. **Duplicates** (existing CollisionReview at `frontend/src/pages/CollisionReview.tsx`) folded into the same Data Cleanup view.
18. ✅ **Strip quoted email replies before embedding** — **answered**: yes. Indexer will strip `>` quote blocks and forwarded-message headers before sending to Voyage.

**✅ All questions answered. Ready to start Phase 1.**
