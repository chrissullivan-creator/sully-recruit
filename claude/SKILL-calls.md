# Sully Recruit — Calls Skill

## Call Pipeline Overview

RingCentral calls flow through this pipeline:

1. **RingCentral webhook** fires on call events → writes to `call_logs`
2. **poll-rc-calls** (cron) catches any missed webhooks → backfills `call_logs`
3. **process-call-deepgram** Trigger.dev task:
   - Fetches recording from RingCentral API → stores `audio_url` + `recording_url`
   - Transcribes via Deepgram → stores `transcript` in `ai_call_notes`
   - Claude analyzes transcript → extracts summary, action items, comp intel, reason for leaving
   - Upserts `ai_call_notes` row (keyed on `external_call_id`)
   - Updates candidate fields: `current_title`, `current_company`, comp fields
   - For calls ≥60s on a candidate: sets `status = 'engaged'` (was `back_of_resume` before status enum tightening) + `back_of_resume=true` (boolean column) via the `intel-extraction` lib
   - Logs to `messages` table with `channel = 'call'` for unified inbox

**⚠️ Don't write `status='back_of_resume'` — that violates the CHECK constraint. Use `status='engaged'` for the engagement promotion, and `back_of_resume=true` for the boolean flag separately.**

---

## Database Tables

### `call_logs`
```
id, owner_id, phone_number (+1XXXXXXXXXX E.164 format)
direction (inbound|outbound), duration_seconds
started_at, ended_at, status
notes, summary, audio_url
external_call_id (RingCentral call ID)
linked_entity_type (candidate|contact), linked_entity_id, linked_entity_name
candidate_id, contact_id (FK columns, backfilled from linked_entity)
created_at, updated_at
```

### `ai_call_notes`
```
id, candidate_id, contact_id, call_log_id (FK to call_logs)
phone_number, source, call_direction, call_duration_seconds, call_duration_formatted
call_started_at, call_ended_at
transcript, transcription_provider
ai_summary, ai_action_items
extracted_notes, extracted_reason_for_leaving
extracted_current_base, extracted_current_bonus
extracted_target_base, extracted_target_bonus
recording_url, external_call_id, owner_id
processing_status, embedding
updated_candidates_at, created_at
```

---

## Phone Number Format

**All phone numbers are E.164: `+1XXXXXXXXXX`**

- `normalize_us_phone()` SQL function auto-normalizes on write
- Triggers on `candidates` and `contacts` tables enforce this
- RingCentral always sends E.164 — matching works because DB is normalized too
- Call tagging: `call_logs.phone_number = candidates.phone` (exact E.164 match)

---

## Frontend Components

### Calls Tab (CandidateDetail)
- Tab value: `call-notes` (preserved from original)
- Queries both `call_logs` (by `candidate_id`) and `ai_call_notes` (by `candidate_id`)
- Each call row shows: direction icon, phone, duration, date, summary preview, audio icon
- Clicking opens `CallDetailModal`
- Orphan AI notes (no matching call_log) shown separately

### CallDetailModal (`components/shared/CallDetailModal.tsx`)
- Audio player (if recording exists)
- Joe's Summary (ai_summary)
- Action Items (ai_action_items)
- Extracted Notes
- Comp Intel grid (current/target base/bonus)
- Reason for Leaving
- Collapsible full transcript

### Inbox — Call Messages
- `channel = 'call'` gets phone icon + gold color
- Reply box hidden for call threads (can't reply to a call)
- Messages display normally in chat bubble view

---

## Status Side Effect

Every processed call sets `candidate.status = 'back_of_resume'`.
Displayed as "Back of Resume" (not "Back_of_resume") everywhere:
- CandidateDetail badge uses explicit label mapping
- Candidates list uses `STATUS_LABELS` dict with `replace(/_/g, ' ')` fallback

---

## Key Rules

1. **Phone numbers MUST be E.164** — `+1` followed by 10 digits. The `normalize_us_phone()` trigger handles this automatically.
2. **ai_call_notes upserts on external_call_id** — reprocessing a call overwrites, never duplicates.
3. **call_logs.candidate_id is the source of truth** for linking calls to candidates (not linked_entity_id which is legacy).
4. **Recording URLs expire** — RingCentral URLs have TTL. `process-call-recording` should store a permanent copy in Supabase storage if long-term playback is needed.
