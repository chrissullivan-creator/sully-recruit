# Sully Recruit — Sequences Skill

## Sequence Engine Overview

The engine runs on **Inngest** (not Trigger.dev — the `src/trigger/` name is a
holdover; see CLAUDE.md). Three pieces:

| Piece | Inngest function | Body (engine-neutral) |
|---|---|---|
| **Scheduler sweep** (every 3 min) | `sequence-sweep` (`frontend/api/lib/inngest/functions/sequence-sweep.ts`) | inline |
| **Per-step executor** | `sequence-action-execute` | `runSequenceAction` (`frontend/src/server-lib/sequence-runner.ts`) |
| **Enrollment init** (pre-schedules all steps) | `sequence-enrollment-init` | `runSequenceEnrollmentInit` (`frontend/src/server-lib/enrollment-init-runner.ts`) |

**Flow:** enroll → `sequence/enrollment-init.requested` pre-schedules every
`sequence_step_logs` row → `sequence-sweep` cron claims due rows
(`scheduled` → `in_flight`) and fans out `sequence/action.execute.requested`
→ `runSequenceAction` sends one step and re-anchors the next.

The runner is engine-neutral so a legacy Trigger.dev path can share it; the
live path is Inngest. `sequences.engine` (`'inngest'` | `'trigger'`)
discriminates which sweep owns a sequence — `sequence-sweep` filters
`engine='inngest'` so the two never race for the same row.

**Unified person model:** `sequence_enrollments.candidate_id` and
`.contact_id` BOTH FK to `candidates(id)`. The engine treats candidate- and
client-type enrollees uniformly.

---

## Data Model

```
sequences ──< sequence_nodes ──< sequence_actions      (definition)
sequences ──< sequence_enrollments ──< sequence_step_logs   (runtime)
```

- **`sequence_actions`** is the per-message unit (NOT the old `sequence_steps`).
  Columns: `channel, message_body, subject_line, base_delay_hours,
  delay_interval_minutes, jiggle_minutes, use_signature, reply_to_previous,
  attachment_urls, sender_user_id, post_connect_delay_hours`.
- **`sequence_nodes`** group actions and carry ordering
  (`node_order`, plus `branch_id`/`branch_step_order` for A/B branches).
- **`sequence_step_logs`** is the execution log — one row per action per
  enrollment, pre-scheduled at init. Columns: `status, scheduled_at, sent_at,
  channel, node_id, action_id, skip_reason, reply_received_at, reply_text,
  sentiment, internet_message_id, opened_at, open_count`.
- **Duplicate guard (#400):** migration
  `20260702024451_prevent_duplicate_sequence_work.sql` stops duplicate live
  enrollments before adding unique indexes for one `active|paused` enrollment
  per `(sequence_id, candidate_id/contact_id)` and one open
  `scheduled|pending_connection|in_flight` step log per
  `(enrollment_id, action_id)`.

### `sequence_step_logs.status`

| status | meaning |
|---|---|
| `scheduled` | due to fire at `scheduled_at` |
| `in_flight` | claimed by a sweep, mid-execute (auto-recovered after 10 min) |
| `sent` | delivered |
| `skipped` | pre-flight skip (no email/phone/LinkedIn, already connected, bounced) |
| `cancelled` | enrollment stopped/paused before it fired |
| `pending_connection` | LinkedIn message parked until the connection request is accepted |

### `sequence_enrollments.status`

| `status` | `stop_trigger` | meaning |
|---|---|---|
| `active` | — | running |
| `paused` | — | sequence or enrollment manually paused |
| `stopped` | `reply_received` / `email_bounced` / `email_invalid_bounced` / `calendar_booked` / `duplicate_enrollment` / … | terminated early |
| `completed` | `completed` | all steps fired/skipped |

---

## Critical Rules

### 1. Connection request MUST precede a LinkedIn message
At init, `linkedin_message` is parked as `pending_connection` when the
recipient isn't connected yet. The Unipile webhook promotes it to `scheduled`
on acceptance (`post_connect_delay_hours`, default 24h, + jitter). If you see
empty/early `linkedin_message` sends, check the connection step.

**Duplicate connection-invite skip (2026-06-27, #384).** Before sending a
`linkedin_connection` step, `runSequenceAction` now calls
`isLinkedInConnected()` (`send-channels.ts` — reads network distance live, v2
when available else v1, **defaults to `false` on error** so a cheap idempotent
invite still proceeds). If already 1st-degree it marks the step
`skipped` (`already_connected`), calls `markConnectionAccepted()` and advances —
no duplicate invite. The enrollment-time skip only saw a cached flag; this
re-checks live since a recipient can connect between enrollment and send (and
the connection webhook never fires for an invite that was never sent).
`markConnectionAccepted()` + `schedulePendingConnectionLogs()` now live in the
shared `frontend/src/server-lib/connection-accept.ts` so the `check-connections`
cron and this runtime guard share one path.

### 2. Reply guard stops everything except OOO auto-replies
`hasRepliedSinceEnrollment()` scans `messages` for an `inbound` row (excluding
`message_type='connection_accepted'` and `message_type='auto_reply'`) since
`enrolled_at`, matching on `candidate_id`/`contact_id`. It runs both in the
webhook handlers (which call `stopEnrollment`) and again inside
`runSequenceAction` before any send.
`stopEnrollment` flips status to `stopped` and cancels all remaining
`scheduled` + `pending_connection` logs.

OOO is different: Microsoft/Unipile email handlers run `decideOutOfOffice()`
before stamping `last_responded_at`. If the reply is OOO, the message is tagged
`message_type='auto_reply'`, the enrollment is rescheduled via
`rescheduleEnrollmentForOOO()`, and the person does **not** count as having
answered.

### 3. Idempotency / no double-send
`runSequenceAction` bails unless the step_log is still `in_flight` (the sweep
is the only writer of that state), so a retry after a post-send crash can't
re-send.

The database also enforces no duplicate open sequence work (#400): one live
enrollment per person/sequence, and one open step log per enrollment/action.

### 4. Rate-limit & transient handling
LinkedIn `limit_exceeded` / 429 → step rescheduled +2h (still `scheduled`).
Transient infra errors (fetch failed, timeout, Unipile unreachable) →
rescheduled +30 min. Neither marks the step failed.

---

## Send Window, Jitter, Caps

All timing lives in `frontend/src/server-lib/send-time-calculator.ts`.

- **Timezone** is per-sequence (`sequences.timezone`, picked in the builder),
  resolved through `Intl` so it's DST-correct. Defaults to `America/New_York`.
  Every caller threads it in (`enrollment-init-runner`, `reanchorNextStep`,
  the connection-accept handlers); there are **no hardcoded UTC offsets**.
- **Send window** is per-sequence (`send_window_start` / `send_window_end`,
  `"HH:MM"`, in the sequence timezone), default **09:00–18:00**. Delay hours
  tick *only inside* the window. `weekdays_only` rolls Sat/Sun to Monday open.
- **`linkedin_connection` bypasses the window** — fires 24/7 (+0–3 min
  anti-burst offset) **but now still honors the per-channel daily + hourly caps**
  (2026-06-24, #362). Previously it early-returned before the cap checks, so a
  batch enrollment scheduled every invite for ~now and one sweep fired them all
  at once, blowing past LinkedIn's daily-invite ceiling. `calculateSendTime`
  now rolls a connection forward over `checkDailyCap`/`checkHourlyCap` (hot-spot
  snapping still skipped for connections).
- **Jitter:** per-action `jiggle_minutes` (±), re-clamped into the window;
  plus deterministic per-hour "hot-spot" snapping so independently-scheduled
  enrollments cluster like a human instead of bunching at HH:00.
- **Caps:** `channel_limits` (daily/hourly per channel) + `daily_send_log`
  counter. `calculateSendTime` rolls a step to the next day/hour when a cap is
  hit, at init time, so steps don't pile onto one day. **Editable in the UI** at
  Settings → Send Limits (`ChannelLimitsSettings`); the builder's "estimated
  daily sends" warnings and the schedule view's utilization bars read the same
  table via `useChannelLimits()` — no hardcoded cap numbers anywhere.

> Note: the old doc claimed "4:30 AM–9:30 PM CST" — that was never the code.
> The window is the per-sequence, timezone-aware window above.

## Compliance — do_not_contact

`people.do_not_contact` is a hard global suppression. When an inbound reply is
classified `do_not_contact`, `intel-extraction` sets it. The engine then
refuses to message that person again, on any sequence: `enrollment-init-runner`
stops a new enrollment before scheduling, and `runSequenceAction` stops any
in-flight enrollment at its pre-flight check (`stop_trigger='do_not_contact'`).

`people.email_invalid` is also treated as a stop signal for email sequences.
Bounce handlers set `email_invalid=true` and stop active enrollments; enrollment
init and send-time preflight now stop the enrollment with
`stop_trigger='email_invalid_bounced'` instead of repeatedly skipping future
email steps.

---

## Channels

`sequence_actions.channel`:

```
email                Outlook via Microsoft Graph (or Unipile v2, kill-switch USE_UNIPILE_EMAIL)
sms                  RingCentral (Chris + Nancy only — Ashley has no RingCentral)
linkedin_connection  connection request (300-char limit, 24/7)
linkedin_message     classic LinkedIn DM (requires prior connection)
linkedin_inmail      Recruiter InMail (credit-guarded)
manual_call          logged only, no send
```

`canonicalChannel()` folds Sales Navigator into `linkedin`. LinkedIn sends go
through `sendLinkedIn` in `send-channels.ts` (Unipile v2 when
`USE_LINKEDIN_V2_SEND` + `acc_xxx` present, else v1). See CLAUDE.md for the
v1/v2 split.

### Recipient resolution
Email column is role-aware: candidates → `personal_email` (falls back to
`primary_email`), clients → `work_email`. Non-email steps pre-skip when the
recipient lacks the channel's contact field; email is resolved again at send
time so late enrichment can still land before dispatch. `email_invalid` (hard
bounce) is never re-attempted; it stops email sequence work until the address is
corrected.

---

## Replies, Sentiment & Intel

On every inbound reply the webhook processors (`process-unipile-event`,
`process-microsoft-event`, `process-ringcentral-event`) run
`extractMessageIntel` + `applyExtractedIntel`
(`frontend/src/server-lib/intel-extraction.ts`, Claude Haiku), which writes:

- `reply_sentiment` table (per reply, with `enrollment_id`)
- `sequence_enrollments.reply_sentiment` / `.reply_sentiment_note`
- person `last_sequence_sentiment` / `last_sequence_sentiment_note`
- extracted recruiting fields (comp, notice, locations, …) onto the person

Sentiment vocab (the `reply_sentiment_sentiment_check` CHECK now permits all 9,
widened 2026-06-25): `interested | positive | maybe | neutral | negative |
not_interested | do_not_contact | ooo | booked_meeting`. `intel-extraction.ts`
clamps any off-vocab/hallucinated value to `neutral` via `safeSentiment`
(`ALLOWED_SENTIMENTS`) before writing — and the `do_not_contact` branch keys off
the clamped value. The calendar handler stamps `booked_meeting` (stop_trigger
`calendar_booked`). Keep `SequenceAnalyticsPage` `SENTIMENT_COLORS` and
`CandidateDetail` `SENTIMENT_CONFIG` in sync with this list.

For a genuine non-OOO reply, the webhook stamps `last_responded_at`, then
`stopEnrollment(..., 'reply_received', replyText)` terminates the enrollment and
`triggerSentimentAnalysis` stamps `reply_received_at` + `reply_text` on the
last *sent* step so the analytics funnels can attribute the reply. OOO/returned
mail/bounce signals are operational warnings, not human answers. (This does NOT
call any AI — sentiment is already done above.)

---

## Analytics — where the numbers come from

`SequenceAnalyticsPage`:

- **Enrolled / active / completed / reply rate** — `sequence_enrollments`
  (`status`, `stop_trigger='reply_received'`).
- **Sends / skipped / failed** — `sequence_step_logs.status`.
- **Open rate** — `opened_at` / `open_count` from the email tracking pixel.
- **Sentiment breakdown** — `sequence_enrollments.reply_sentiment`
  (+ `booked_meeting` from `stop_trigger`). Do NOT read
  `sequence_step_logs.sentiment` — that column is effectively never written.
- **Per-step / per-channel replies** — attributed to each replied
  enrollment's last sent step.

---

## Pausing All Sequences (Emergency)
```sql
UPDATE sequence_enrollments
SET status = 'paused', updated_at = NOW()
WHERE status = 'active';
-- and/or pause the parent so the sweep skips it:
UPDATE sequences SET status = 'paused' WHERE status = 'active';
```
Both the sweep query and `runSequenceAction` re-check `status='active'` on the
enrollment AND its sequence, so a pause halts sends within one sweep (≤3 min).
