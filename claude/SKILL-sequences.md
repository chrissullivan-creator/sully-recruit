# Sully Recruit — Sequences Skill

## Sequence Engine Overview

The engine runs via `run-sequences` edge function, triggered by cron every 60 seconds. It processes all active enrollments where `next_step_at <= NOW()`.

---

## Critical Rules

### 1. Connection Request MUST precede LinkedIn Message
- Hard UI guardrail — cannot add `linkedin_message` without prior `linkedin_connection` step
- Engine enforces at runtime — skips `linkedin_message` for non-connections
- **If you see empty `linkedin_message` sends — check for missing connection request step**

### 2. Reply Detection Guard
`hasRepliedSinceEnrollment()` checks BOTH:
- `candidate_id` match on messages table
- `sender_address` match (email address based)

Both checks must clear before any step fires. This prevents double-sending when candidate_id is null.

### 3. LinkedIn Circuit Breaker
`liLimitHit` — a `Set<string>` per account ID. When Unipile returns `limit_exceeded`, ALL LinkedIn steps for that account are skipped for the rest of that cron run.

### 4. Connection Status Pre-flight
Before every LinkedIn message step:
- Check connection status via Unipile API
- `already_connected` → fire the message immediately, log `linkedin_connection_status = 'already_connected'`
- `pending` → park enrollment, set `waiting_for_connection_acceptance = true`, `next_step_at = null`
- `not_connected` → if step is `linkedin_connection`, send request and park. If step is `linkedin_message`, skip.

---

## Send Window

**4:30 AM – 9:30 PM CST** for all message types.
**Connection requests are EXEMPT** — fire 24/7.

Enforced per step via `respect_send_window` flag on `sequence_steps`.

---

## Jitter

- **Per enrollee:** 2–35 min randomized offset on `next_step_at` at enrollment time
- **Per LinkedIn message:** ±43 min additional jitter when step fires

This prevents burst sends that trigger spam detection.

---

## Webhook-Driven Connection Advancement

1. Send connection request → set `waiting_for_connection_acceptance = true`, `next_step_at = null`
2. Unipile fires webhook on acceptance → `unipile-webhook` advances enrollment to next step
3. Next step fires after `post_connect_delay_hours` (default 24h) + jitter

**`next_step_at = null` ≠ paused.** It means parked/waiting for an event.

---

## `sequence_steps` Columns

```
id, sequence_id, step_order, channel, step_type
subject, content, account_id
delay_days, delay_hours
send_window_start, send_window_end  (hour 0-23)
respect_send_window (boolean)
jitter_min_minutes, jitter_max_minutes
inter_message_jitter_minutes
post_connect_delay_hours
post_connect_jitter_min, post_connect_jitter_max
wait_for_connection (boolean)
is_reply (boolean)
use_signature (boolean)
```

---

## `sequence_enrollments` Key States

| `status` | `next_step_at` | `waiting_for_connection` | Meaning |
|---|---|---|---|
| `active` | future timestamp | false | Normal — waiting to fire |
| `active` | null | true | Parked — waiting for connection accept |
| `paused` | null | false | Manually paused |
| `stopped` | null | false | Reply received or manually stopped |
| `completed` | null | false | All steps fired |

---

## Pausing All Sequences (Emergency)
```sql
UPDATE sequence_enrollments
SET status = 'paused', paused_at = NOW(), updated_at = NOW()
WHERE status = 'active';
```

---

## Channel Types
```
linkedin_connection     connection request (300 char limit, 24/7)
linkedin_message        classic LinkedIn DM (must have prior connection step)
linkedin_recruiter      Recruiter InMail (Nancy only)
sales_nav               Sales Nav InMail (Chris only)
email                   Outlook via Microsoft Graph
sms                     RingCentral (Chris + Nancy only, NOT Ashley)
phone                   Call log/script
```

---

## Sentiment Analysis on Reply
All three webhook functions (unipile, outlook, ringcentral) run Claude Haiku sentiment on every inbound reply:
- Writes to `reply_sentiment` table
- Stamps `last_sequence_sentiment` + `last_sequence_sentiment_note` on candidate/contact
- `do_not_contact` classification should trigger auto-stop (compliance risk)

---

## Analytics — What's in the DB

From `sequence_enrollments`:
- Total enrolled, active, paused, stopped, completed
- Replied = `status = 'stopped' AND stopped_reason ILIKE '%reply%'`
- Reply rate = replied / total

From `sequence_step_executions`:
- Total sent, failed, delivery rate
- Step-by-step funnel by `step_order`

From `reply_sentiment`:
- Sentiment breakdown per sequence (join via enrollment_id)
