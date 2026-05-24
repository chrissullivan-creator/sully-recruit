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

### Migration of existing data

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

### Phase 5 — Person-based persistence + Sent folder + auto-add + backfill (~5 days)

Files:
- **Migrations**: `inbox_saved_views`, `inbox_event_log`, `people.needs_classification` + `auto_added_at` + `auto_added_source`.
- `frontend/src/server-lib/resolve-counterparty.ts` (new) — normalize address/provider_id and look up `candidate_channels` / `contact_channels`.
- `frontend/src/server-lib/auto-create-person.ts` (new) — used by outbound handlers when recipient isn't in CRM. Defaults `type='candidate'`, sets `needs_classification=true`, fires `person.created`.
- **Webhook + send-path changes**:
  - `frontend/api/webhooks/unipile-events.ts` (and Microsoft, RingCentral) — switch inbound to recognition-gated persistence. SMS always persists. Outbound always persists; auto-creates person if needed.
  - **Audit all send endpoints** to confirm they call `persistOutbound()`: Outlook email send, LinkedIn DM send, LinkedIn Recruiter InMail send, RingCentral SMS send. Add the call wherever missing.
- `frontend/src/server-lib/inngest/backfill-person-communications.ts` (new) — fires on `person.created`. Fetches past email + LinkedIn + SMS for the new person; dedupes; AI-tags.
- Wire the `person.created` event for **every** path that inserts into `people` (Add Person Wizard, resume parsing, sequence enrollment, manual add, LinkedIn import, **auto-create from outbound**). Centralize via a `createPerson()` helper if not already.
- `frontend/api/inbox/live-threads.ts` (new) — proxy that returns last 100 threads per channel from Unipile / Microsoft for unknown-sender display.
- **Sent folder**: new sidebar view + query (`inbox_threads` filtered to last-message-outbound, scoped to current user). No new endpoint needed.
- **Needs Classification view**: new sidebar view + UI for `people WHERE needs_classification = true`. Inline classifier banner in the reading pane.
- Frontend: React Query hook unions persisted Supabase rows + live-API rows; dedupes on `external_conversation_id`.

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

Once you answer these, I'll start Phase 1 (timestamps + list polish — biggest UX win, no DB risk).
