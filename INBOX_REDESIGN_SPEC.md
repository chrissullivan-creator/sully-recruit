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
- **Show all messages, save only the ones that belong to a person in the CRM.** Inbox reads live from Unipile/Microsoft/RingCentral and renders everything. Supabase only persists messages where the sender or recipient is already a candidate or client. When a new person is added to the CRM, their past communications backfill automatically.
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

**New rule:** show every message in the inbox UI, but **only save to Supabase when the sender or recipient is already a person in the system** (candidate or client). This keeps communication tagged to that person's record, without bloating the DB with messages from unknown senders.

### The rule, plainly

| Action | Storage |
|---|---|
| Inbox displays a message | Always (fetched live from Unipile / Microsoft / RingCentral, no DB write required). |
| Message persisted to `conversations` + `messages` | **Only if** the sender's email / LinkedIn ID / phone resolves to an existing `people` row, OR the recipient does, OR the message is outbound from us. |
| User clicks "Add person" on an unknown sender | Future messages from that person auto-persist; optional one-click backfill of the past thread. |

### Why
- 21k messages today, most never linked to a candidate or client = noise.
- Privacy: random newsletters, personal mail, vendor pitches don't belong in the CRM.
- Keeps the principle that **everything in `messages` is tagged to a person** — which is the whole point of the CRM.

### Recognition logic — "is this person in the system?"

When a webhook fires (or when the UI fetches a live message), we resolve the counterparty:

1. **Email**: lookup `candidate_channels.address` or `contact_channels.address` (via the `people` table) for the inbound `sender_address` and the outbound `recipient_address`. Use normalized email (lowercased, plus-tag-stripped).
2. **LinkedIn**: lookup `candidate_channels.provider_id` against the Unipile attendee ID (or LinkedIn `public_identifier` / member URN).
3. **SMS**: lookup `candidate_channels.address` against the E.164 phone number.
4. **Outbound**: always persist (it's something *we* sent — it belongs in the timeline).

If a match is found → write to `conversations` + `messages` with the resolved `candidate_id` or `contact_id`. If no match → drop the body / payload; the live inbox UI still shows it via direct API fetch.

### Webhook handler changes (concrete)

Currently `frontend/api/webhooks/unipile-events.ts` (and Microsoft / RingCentral equivalents) write every inbound message. New behavior:

```ts
async function handleInboundMessage(payload) {
  await supabase.from('inbox_event_log').insert({ ...metadata });   // lightweight trace

  const personMatch = await resolveCounterparty({
    channel: payload.channel,
    address: payload.sender_address,          // email / phone
    provider_id: payload.sender_attendee_id,  // LinkedIn URN / Unipile attendee
  });

  if (!personMatch) {
    // Not in the system. Don't persist body. UI will fetch live from Unipile if needed.
    return;
  }

  // In the system → persist with person tagging.
  await supabase.from('messages').insert({
    ...messageRow,
    candidate_id: personMatch.role === 'candidate' ? personMatch.id : null,
    contact_id:   personMatch.role === 'client'    ? personMatch.id : null,
  });
  await upsertConversation(personMatch, payload);
}
```

A new shared helper `frontend/src/server-lib/resolve-counterparty.ts` does the lookup — used by all webhook handlers and any live-fetch normalizer.

### Outbound messages

Always persist outbound (sequences, manual replies, etc.) — those are first-party data and *we* know who we sent to. Even if the recipient isn't yet in the system, the act of sending to them should create the person on the fly (this is already the case in some paths; ensure it's consistent across email/LinkedIn/SMS send endpoints).

### Live inbox fetch path

For threads NOT persisted (sender unknown), the UI hits a new endpoint:

- `GET /api/inbox/live-threads` — proxies Unipile + Microsoft Graph + RingCentral, returns the last ~30 days of threads with normalized shape (`{ id, channel, sender, subject, preview, last_message_at, ... }`).
- React Query caches with 60s stale; SSE/webhook tickle invalidates.
- Merging: frontend unions persisted Supabase rows + live-API rows, dedupes by `external_conversation_id`.

### Adding a person → auto-backfill past communications

When a person is added to the CRM — by **any path** (Add Person Wizard from the inbox, resume parsing, manual add, LinkedIn import, sequence enrollment, etc.) — the system **automatically fetches and saves all past communications** with that person from every connected channel. No opt-in prompt. This is the contract: if you're in the CRM, your history with us is in the CRM.

**Trigger**: any insert into `people` that also has a resolvable address/identifier in `candidate_channels` or `contact_channels`.

**Implementation**: a new Inngest job `backfill-person-communications` (`frontend/src/server-lib/inngest/backfill-person-communications.ts`) fires on a `person.created` event. It:

1. Reads all channel identifiers from `candidate_channels` / `contact_channels` for the new person.
2. For each channel:
   - **Email** (Microsoft Graph): query `/me/messages?$search="from:{email}" OR "to:{email}"` (paged); also folder-scoped (Inbox + Sent).
   - **LinkedIn DM / Recruiter** (Unipile v1): `GET /chats?account_id=X` filtered to attendee = the LinkedIn provider ID. Then `GET /chats/{id}/messages` for each match.
   - **SMS** (RingCentral): list messages with the matching phone number.
3. Writes everything to `conversations` + `messages` with the resolved `candidate_id` or `contact_id`.
4. Skips messages already present (dedupe on `external_message_id`).
5. AI-tags the backfilled messages so candidate timeline + send-out state derives correctly.

**Bounds**: configurable lookback (default: 24 months) to avoid surprise massive backfills. Surface a small toast in the UI: "Backfilling past communications for {name}…" with a count when done.

**Failure mode**: if a channel API errors mid-backfill, mark the job as partial and retry that channel only. Don't block the person creation.

**Going forward** after the person is added, the webhook recognition logic naturally picks up new messages with no extra work.

### Migration of existing data

Existing 10k conversations + 21k messages stay (forward-looking change). Optional cleanup script later:
- Identify `messages` rows with `candidate_id IS NULL AND contact_id IS NULL` AND no AI tags AND older than 6 months → archive / delete.
- Don't run automatically; surface as a one-off cleanup tool.

### Risk / things to watch

- **Search across history**: only persisted (tagged-to-person) threads are searchable inside Sully. Unknown-sender messages live only in the source provider; if you want to find them, use the provider's own search (or hit Unipile search via the "Search inbox provider…" affordance — see §4.10).
- **Latency**: Unipile/Microsoft fetch on inbox open. Cache aggressively (60s React Query). On first paint, show persisted rows immediately and live rows as they arrive.
- **Rate limits**: page ≤50 threads, cursor pagination.
- **Sequence engine**: sequences only enroll candidates already in the system → their messages auto-resolve and persist via the recognition rule. No special case needed.
- **Counterparty edge cases**: forwarded emails, group threads, dist lists. Rule: if ANY counterparty (sender OR primary recipient) matches a person, persist with that person. If multiple match (rare), pick the first; surface both in the UI.

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
  Unread          (count badge)
  Starred
  Snoozed         (count + soonest wake)
  Awaiting reply  (count)
  Sent
  Drafts
  Archive
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

Every row in `conversations` is now, by definition, tagged to a person (the recognition rule). No `is_persisted` flag needed.

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

### Phase 5 — Person-based persistence + auto-backfill (~4 days)

Files:
- Migration: `inbox_saved_views`, `inbox_event_log`.
- `frontend/src/server-lib/resolve-counterparty.ts` (new) — normalize address/provider_id and look up `candidate_channels` / `contact_channels`.
- `frontend/api/webhooks/unipile-events.ts` (and Microsoft, RingCentral) — drop the unconditional write; call `resolveCounterparty()`, persist only on match. Always persist outbound.
- `frontend/src/server-lib/inngest/backfill-person-communications.ts` (new) — fires on `person.created`; fetches and saves past email + LinkedIn + SMS messages for the new person.
- Wire the trigger: every code path that inserts into `people` emits a `person.created` event (Add Person Wizard, resume parsing, sequence enrollment, manual add, LinkedIn import). Centralize via a `createPerson()` helper if not already.
- `frontend/api/inbox/live-threads.ts` (new) — proxy endpoint that calls Unipile/Microsoft and returns normalized threads for the inbox UI (used for unknown senders).
- Frontend: React Query hook unions persisted Supabase rows + live-API rows for display; dedupes on `external_conversation_id`.

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

1. **Backfill lookback window**: default 24 months — too short, too long? Some senior candidates might have 3+ years of LinkedIn DM history we'd want.
2. **Backfill on existing people**: when this ships, do we run a one-time backfill pass on the existing ~N candidates/clients to catch any pre-existing messages we'd have dropped? Or only apply to people added going forward?
3. **AI tagging on non-persisted messages**: do we still run Joe's classification on every webhook even when the sender isn't in the system (to catch e.g. an unknown person sending "I accept the offer" — implying they're a candidate we should add)? Cost vs catching edge cases.
4. **Counterparty edge cases — group threads, forwards, distribution lists**: if a single email has multiple recipients and one matches a candidate, do we save the whole thread to that candidate, or just the messages where they were directly addressed? Default: save the thread, tagged to that candidate.
5. **Default density**: Comfortable or Compact?
6. **Focused vs Other criteria**: "Focused" = linked to a candidate/client (= everything persisted in Supabase). "Other" = live-fetched unknown senders. Confirm — or include sequences / open send-outs in Focused?
7. **Snooze wake notification**: push notification when a snoozed thread wakes up, or silent re-appear in inbox? (Vote: silent + "Welcome back" banner.)
8. **Search across unknown-sender history**: only the provider's own search (via a "Search inbox provider…" affordance), OR keep a 30-day rolling snapshot of all inbound for global search even if we don't permanently persist?
9. **Existing 21k messages + 10k conversations cleanup**: leave as-is (forward-only change), or run a one-time cleanup script (delete messages where `candidate_id IS NULL AND contact_id IS NULL` + older than 6 months + no AI tags)?
10. **Event log TTL**: `inbox_event_log` is debug-only — 7-day TTL OK, or longer?

Once you answer these, I'll start Phase 1 (timestamps + list polish — biggest UX win, no DB risk).
