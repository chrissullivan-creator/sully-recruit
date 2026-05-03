# Sully Recruit — Schema Terminology

Canonical names for things that show up in many places. After Pass 5a (unified person model + cleanup) the schema is mostly consistent, but a few legacy columns remain. This doc tells you which name to use when writing new code.

---

## Person reference

After Pass 5a, **all "person" rows live in `candidates`** (with a `type` column = `'candidate'` or `'client'`). The `contacts` table is a backwards-compat VIEW.

| Column name in dependent table | What to use it for | Status |
|---|---|---|
| `candidate_id` (FK candidates) | Person reference. Works for both candidate-type and client-type. | Current |
| `contact_id` (FK candidates)  | Same as candidate_id. Both columns coexist on messages/conversations/etc. for legacy reasons. | Current — will collapse to one column in a future pass |
| `person_id` (FK candidates)   | New canonical name. Used in `v_person_activity` and a few newer columns. | Preferred for new code |
| `entity_type` + `entity_id`   | Polymorphic reference. `entity_type` is one of `candidate`/`contact`/`candidate_job`/`job`. Used by activity-log tables. | Current |
| `related_to_type` + `related_to_id` | Same pattern as entity_type/entity_id, but on `tasks`. | Legacy — will rename to entity_type/entity_id |
| `linked_contact_id` / `linked_candidate_id` | Self-reference — when the same person is BOTH a candidate and a client. | Current |
| `interviewer_contact_id` | Specific FK on `interviews` to the client-side interviewer. Same as candidate_id semantically. | Current |

**Rule:** when adding a NEW column referencing a person, use `person_id` (single FK to candidates(id)). Don't add new `candidate_id` + `contact_id` pairs.

---

## Owner / actor / creator / assignee

This is the messiest area. Multiple columns mean roughly "which user is responsible for this row."

| Column | Tables | Meaning |
|---|---|---|
| `owner_user_id` | candidates, integration_accounts | **CANONICAL OWNER FIELD.** Recruiter who currently owns this row. Use this name for new tables. |
| `owner_id` | call_logs, conversations, interviews, messages, ai_call_notes | Legacy alias for owner_user_id. Same semantics. Will be renamed in a future pass. |
| `created_by_user_id` | candidates | First creator. Never changes after insert. Use this when you need provenance. |
| `created_by` | notes, tasks | Same as created_by_user_id (older naming). |
| `assigned_user_id` | conversations | Currently assigned user (may differ from creator). |
| `assigned_to` | tasks | Same as assigned_user_id (older naming). |
| `recruiter_id` | send_outs | Domain-specific synonym for owner_user_id. |
| `actor_user_id` | status_change_log | The user whose action triggered the log entry. |
| `triggered_by_user_id` | stage_transitions | Same as actor_user_id. |
| `user_id` | ai_runs, integration_accounts, user_integrations | Generic "this row belongs to this user" reference. Used when row is per-user data, not per-action. |

**Rule:** when adding a NEW column for "who owns this", use `owner_user_id`. For "who created this", use `created_by_user_id`. For "who is assigned now", use `assigned_user_id`.

---

## Status / stage / pipeline (and which is which)

Multiple "status" and "stage" columns. They mean different things.

| Column | Domain | Allowed values |
|---|---|---|
| `candidates.status` | Person engagement state | `new` \| `reached_out` \| `engaged` (CHECK-constrained) |
| `candidates.job_status` | **DEPRECATED.** Duplicates candidate_jobs.pipeline_stage. | various; old data only |
| `candidate_jobs.pipeline_stage` | Per-(candidate, job) pipeline stage | `lead` \| `new` \| `reached_out` \| `pitch` \| `pitched` \| `sendout` \| `sent` \| `submitted` \| `interview` \| `interviewing` \| `offer` \| `placed` \| `rejected` \| `withdrew` |
| `jobs.status` | Job opening state | `open` \| `on_hold` \| `filled` \| `closed` |
| `send_outs.stage` | Per-sendout micro-lifecycle | implementation-specific |
| `interviews.stage` | Per-interview state | `scheduled` \| `completed` \| `cancelled` |
| `sequence_enrollments.status` | Outreach sequence lifecycle | `active` \| `paused` \| `stopped` \| `completed` |
| `placements.invoice_status` | Invoice lifecycle for a placement | TBD |

**Rule:** "status" = lifecycle of the row itself. "stage" = position in a multi-step process. They can coexist — e.g., a `sequence_enrollment` has a `status` (is it currently running?) but the candidate also has a per-job `pipeline_stage`.

---

## Activity types (for `v_person_activity` view)

The activity feed unifies 13 source tables. Each row has an `activity_type`:

| activity_type | source_table | What it represents |
|---|---|---|
| `message` | messages | Email / SMS / LinkedIn message in or out |
| `call` | call_logs | RingCentral phone call |
| `ai_note` | ai_call_notes | AI-generated transcript + summary |
| `status_change` | status_change_log | Person engagement state changed |
| `stage_change` | stage_transitions | Pipeline stage changed |
| `note` | notes | Manual note added |
| `meeting` | tasks (with start_time) | Calendar event from Outlook |
| `pitch` | pitches | Candidate pitched for a job |
| `sendout` | send_outs | Sendout sent to client |
| `submission` | submissions | Formal submission to client |
| `interview` | interviews | Interview scheduled or completed |
| `placement` | placements | Candidate placed |
| `rejection` | rejections | Candidate rejected at any stage |
| `merge` | candidate_merge_log | Two records merged into one |

Filter by `person_id` to get a chronological record-of-truth feed for any person (candidate or client).

---

## Stage tables vs candidate_jobs

The pipeline has two complementary models:

1. **`candidate_jobs`** — one row per (candidate, job). The `pipeline_stage` column tracks where this candidate-job pair is RIGHT NOW.
2. **Stage tables** (`pitches`, `send_outs`, `submissions`, `interviews`, `placements`, `rejections`) — one row per ENTRY into a stage. Each row is an EVENT, not a current state.

**Rule:** "where is this candidate in this job?" → `candidate_jobs.pipeline_stage`. "show me all pitches this week" → `pitches` table.

### CANONICAL stage labels (use these EXACT names in UI + docs)

The stage TABLE names and the user-facing UI LABELS differ — this trips people up. Always use the UI label in user-facing strings; the table name is implementation detail.

| Funnel position | UI label | Source table |
|---|---|---|
| 1 | **Pitched** | `pitches` |
| 2 | **Ready to Send** | `send_outs` ← table is named `send_outs`, the stage is "Ready to Send" |
| 3 | **Sent** | `submissions` ← table is named `submissions`, the stage is "Sent" |
| 4 | **Interviews** | `interviews` |
| 5 | **Placements** | `placements` |
| 6 | **Rejections** | `rejections` |

**⚠️ Don't write "Send-Outs" or "Submitted" in user-facing UI.** Write "Ready to Send" and "Sent" respectively. The table names are legacy; they won't be renamed because too many code paths reference them.

---

## Common column conventions

- Timestamps: `*_at` (created_at, updated_at, sent_at, last_contacted_at, etc.)
- Booleans: positive form (`is_active`, `is_connected`, `back_of_resume`, NOT `is_inactive`)
- Foreign keys: `<other_table_singular>_id` (candidate_id, job_id, owner_user_id)
- Counts/aggregates: `*_count` (message_count, call_count)
- JSON columns: untyped where possible, with a comment explaining shape

---

## Future deprecations (not yet executed)

These changes are tracked but not done because they require coordinated app code changes:

1. **Drop `candidates.job_status`** — duplicates `candidate_jobs.pipeline_stage`. Migrate the 200 rows then drop.
2. **Rename `owner_id` → `owner_user_id`** on call_logs, conversations, interviews, messages, ai_call_notes.
3. **Collapse `candidate_id + contact_id` → `person_id`** on messages, conversations, call_logs, ai_call_notes, ai_runs, send_outs, sequence_enrollments, reply_sentiment, search_documents, placements, call_processing_queue.
4. **Rename `tasks.related_to_type/id` → `entity_type/id`** for consistency.
5. **Drop the `contacts` view** after all frontend code queries `candidates` directly.
