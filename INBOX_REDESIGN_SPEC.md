# Inbox Redesign — Spec

**Status:** Draft for review
**Owner:** Chris
**Last updated:** 2026-05-24
**Branch:** `claude/magical-tesla-jVUCk`

This is a design spec, not a build plan yet. Review, push back, then we phase it.

---

## 1. Goals

- **Make timestamps obvious.** No more tiny "3 hours ago" in the corner. Smart formatting (`10:43 AM` / `Yesterday` / `Mon` / `May 12`) plus absolute time on hover. Date group headers in the list.
- **Email reads like email.** Outlook-style cards with `From / To / Date / Subject` headers — not chat bubbles squashing long emails.
- **Chat stays chat.** LinkedIn DMs and SMS keep conversational bubbles. The reading pane swaps layouts based on channel.
- **Workflow > passive view.** Snooze, flag, follow-up reminders, and conversation status (`Awaiting reply` / `Replied` / `Closed`) are first-class.
- **Show all messages, save the ones that matter (per channel).** Inbox shows the last 100 emails / LinkedIn DMs / Recruiter messages live from the providers. Persistence rules: **always save all SMS (in + out)** and **always save outbound** on every channel. Save **inbound email + LinkedIn** only when the sender is already a person in the CRM. When we send to someone not in the CRM, **auto-add them** with a quick Candidate/Client classifier. Adding a person triggers an **automatic backfill** of past communications from every channel. **Sent folder** in the sidebar surfaces everything we've sent across Outlook, LinkedIn, Recruiter, and SMS.
- **Saved messages are RAG-searchable by Joe.** Every persisted message (email, LinkedIn, Recruiter, SMS) gets embedded and indexed into `search_documents`. New Joe tool `search_messages` so he can answer questions like "who said they wanted 30% upside" or "find any message about a non-compete."
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

For inbound from unknown senders (email + LinkedIn):

- `GET /api/inbox/live-threads?channel=email|linkedin|recruiter&limit=100` — proxies Unipile / Microsoft Graph, returns the **last 100 threads** per channel with normalized shape.
- React Query caches 60s; webhook tickle invalidates.
- Frontend unions persisted Supabase rows + live-API rows, dedupes by `external_conversation_id`.

SMS view doesn't need the live endpoint — it's all in Supabase.

### Adding a person → auto-backfill past communications

When a person is added to the CRM — by **any path** (Add Person Wizard from the inbox, resume parsing, manual add, LinkedIn import, sequence enrollment, **auto-add from outbound**, etc.) — the system **automatically fetches and saves all past communications** with that person from every connected channel.

**Trigger**: any insert into `people` with at least one resolvable channel identifier.

**Implementation**: Inngest job `backfill-person-communications` on `person.created`:

1. Read all channel identifiers from `candidate_channels` / `contact_channels` for the new person.
2. For each channel:
   - **Email** (Microsoft Graph): query `/me/messages?$search="from:{email}" OR "to:{email}"` (paged); both Inbox + Sent.
   - **LinkedIn DM / Recruiter** (Unipile v1): `GET /chats?account_id=X` filtered to attendee = the LinkedIn provider ID. Then `GET /chats/{id}/messages` for each match.
   - **SMS** (RingCentral): list messages with the matching phone number.
3. Write to `conversations` + `messages` tagged to the new person.
4. Dedupe on `external_message_id`.
5. AI-tag the backfilled messages.

**Bounds**: configurable lookback (default 24 months). Toast: "Backfilling past communications for {name}…"

**Failure mode**: partial-channel failure retries that channel; doesn't block person creation.

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

5. **New Joe tool** `search_messages` in `supabase/functions/ask-joe/index.ts`:
   ```
   name: "search_messages",
   description: "Semantic + keyword search across all saved communications
                (emails, LinkedIn DMs, Recruiter InMails, SMS). Returns the
                message excerpts plus the person, channel, direction, and date.
                Use to answer 'who said X' or 'find any message about Y'."
   input: { query: string, person_id?: uuid, channel?: string, direction?: string,
            since?: date, limit?: int (default 8) }
   ```
   Calls a new RPC `match_messages_hybrid(query_embedding, query_text, ...)` that combines `match_search_documents(filter_kinds=['message'])` (vector) with `search_search_documents` (FTS via `fts` column) and reciprocal-rank-fusion merges them — same pattern as `search_people` today.

6. **Joe system prompt update** — add `search_messages` to the tools list and a one-line hint: "Use `search_messages` for questions about what someone said, agreed to, complained about, asked for, etc."

7. **Also index calls** (low-effort bonus) — `search_documents.source_kind` already supports `'call'`. Call transcripts (from Deepgram, via `call-deepgram-runner.ts`) can use the same indexer pattern. Skip for this phase unless trivial; track as a follow-up.

**Privacy / scope note:**
- Only messages already persisted under the new storage rule get indexed (i.e. tagged to a person in the CRM). Unrecognized inbound is never embedded.
- Outbound is always indexed (it's always persisted under the new rule).
- SMS always indexed (it's always persisted).
- This means RAG search scope = exactly the message body of every persisted message.

**Cost:**
- Voyage Finance-2 embeddings: ~$0.00012 per 1K tokens. Typical message ~200 tokens. Going-forward steady-state at ~50 saved messages/day = ~$0.12/year. Negligible.
- Backfill of 21k existing: ~$2.50 one-time.

**Files:**
- `frontend/src/server-lib/index-message.ts` (new) — indexer helper. Builds doc + calls Voyage embed in one go.
- `frontend/api/lib/inngest/functions/index-message.ts` (new) — Inngest wrapper.
- `frontend/api/lib/inngest/functions/backfill-message-search-documents.ts` (new) — Step A backfill (missing rows).
- `frontend/api/lib/inngest/functions/backfill-message-embeddings.ts` (new) — Step B backfill (missing embeddings).
- New migration: `match_messages_hybrid` RPC (hybrid vector + FTS via RRF). Optional; could call the two existing RPCs from the tool handler and merge in JS.
- `frontend/supabase/functions/ask-joe/index.ts` — add `search_messages` tool + handler.
- Update `persistMessage()` helper (or the 13 insert sites) to enqueue `messages/indexed.requested`.
- Tweak `BASE_SYSTEM_PROMPT` in ask-joe to mention `search_messages` and chain hint (e.g. `search_messages('compensation') → get_person_detail`).

**Effort revision: ~3 days** (was ~2). The +1 day covers the two-step backfill, embedding ~21k rows, and verifying the existing April 2026 batch's data shape works for our new indexer (or whether we should re-index those rows with our new shape — vote: re-index for consistency).

---

## 7. Open questions for Chris

1. **Live-fetch cap of 100 — per channel or total?** Email last 100 + LinkedIn last 100 + Recruiter last 100 = up to 300 rows in the "Other" view. Or one combined cap of 100?
2. **Auto-add default type**: defaulting to `candidate` when we send to an unknown email/LinkedIn. Right call, or default to `client` based on context (e.g. domain matches a known client company in `companies`)?
3. **Auto-add from sent — what if the email is to e.g. `support@vendor.com` or my own teammates?** Suggest a deny-list (own domain, distribution lists, common service addresses). Confirm.
4. **AI-guess classification on auto-add**: parse signature / domain / message context to guess candidate vs client and pre-fill the type? Reduces the "Needs classification" backlog.
5. **Backfill lookback window**: default 24 months. Long enough? Some senior candidates have 3+ years of LinkedIn DM history.
6. **Backfill on existing people**: when this ships, run a one-time backfill on existing candidates/clients to catch pre-existing messages we'd have dropped under the old behavior? Or forward-only?
7. **AI tagging on non-persisted inbound**: still run Joe's classification on every inbound webhook even when the sender isn't in the system (to flag e.g. an unknown person saying "I accept the offer")? Cost vs catching edge cases.
8. **Counterparty edge cases — group threads, forwards, dist lists**: if a single email has multiple recipients and one matches a candidate, save the whole thread tagged to that candidate? Default yes.
9. **Default density**: Comfortable or Compact?
10. **Focused vs Other criteria**: "Focused" = persisted threads (people in CRM). "Other" = live-fetched from unknown senders. Confirm.
11. **Snooze wake notification**: push notification or silent re-appear with a "Welcome back" banner?
12. **Search across unknown-sender history**: provider's own search only (via a "Search inbox provider…" affordance)? Or keep a 30-day rolling snapshot for global search?
13. **Existing 21k messages cleanup**: leave as-is, or one-time cleanup of inbound rows where `candidate_id IS NULL AND contact_id IS NULL` + channel ∈ (email, linkedin, linkedin_recruiter) + older than 6 months?
14. **Event log TTL**: 7 days OK for the debug-only `inbox_event_log`?
15. **Audit scope for outbound persistence**: Phase 5 audits every send endpoint to ensure it persists. Do you want me to first do a read-only pass and report which send paths today already persist vs not, before changing anything?
16. **Sequence cross-channel stop — AI soft-match**: when an inbound looks like it's from a known candidate but no channel-ID matches (e.g. new LinkedIn account we haven't linked), should we use an AI soft-match to stop the sequence anyway (with a "confirm match" prompt to the user)? Or is hard-channel-match strict enough?
17. **Sequence pre-enrollment warning**: surface a warning before enrolling someone in an email sequence if we have their LinkedIn URL but no `candidate_channels` row for it (so a LinkedIn reply might not get recognized)? Or silently auto-create the channel row from `people` fields?
18. **RAG — strip quoted email replies from indexed body?** Email replies often include the entire prior thread in `>` quotes. Strip them before embedding so the search isn't dominated by duplicated text? Default yes.
19. **RAG — also index calls in this phase?** `search_documents.source_kind` already supports `'call'`. Call transcripts (from Deepgram) could use the same indexer for ~½ day extra. Or defer to a follow-up?

Once you answer these, I'll start Phase 1 (timestamps + list polish — biggest UX win, no DB risk).
