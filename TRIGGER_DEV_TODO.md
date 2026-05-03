# Trigger.dev — Manual Cleanup TODO

After merging branch `claude/cleanup-supabase-HSuA4` to `main`, your Trigger.dev project will be out of sync until you do these steps in the Trigger.dev dashboard.

---

## 1. Delete schedules for 20 removed tasks

These task `.ts` files were deleted from the repo in commit `7bc9138`. After deploy, Trigger.dev will report them as "task not found" on every cron tick. Delete each schedule from the Trigger.dev dashboard → Schedules tab.

| Task ID | Old cadence |
|---|---|
| `match-jobs` | every 6 hours |
| `best-match-job` | manual |
| `backfill-avatars` | daily 3am UTC |
| `backfill-companies` | daily 4am UTC |
| `enrich-linkedin` | daily 7am UTC |
| `fetch-company-logos` | daily 5am UTC |
| `linkedin-lookup` | daily 6:30am UTC |
| `linkedin-profile-viewers` (track-profile-viewers) | daily 11am UTC |
| `linkedin-inmail-monitor` (monitor-inmail-credits) | daily 2am UTC |
| `backfill-calendar-events` | manual |
| `sync-outlook-contact` | manual |
| `backfill-outlook-contacts` | manual |
| `enrich-clay` (push-to-clay) | daily 10am + 8pm UTC |
| `run-nudge-check` | weekdays 2pm UTC (9am ET) |
| `candidate-dedup` (scan-duplicate-candidates) | daily 6am UTC |
| `sync-activity-timestamps` | manual |
| `linkedin-auto-accept` (auto-accept-connections) | daily 9am UTC |
| `linkedin-engagement` (warmup-candidate) | manual |
| `backfill-resume-links` | manual |

**Note:** I restored `sync-outlook-events` and `backfill-calendar-events` per direction — those should NOT be deleted. They're back in the repo.

---

## 2. Re-enable scheduled tasks you turned off Friday

You disabled scheduled tasks because of "so many errors". The root cause was the missing `candidate_channels` table — that's now created. Re-enable these (they're in the keep list):

### Inbox sync (high frequency)
- `backfill-emails` — every 5 min
- `backfill-linkedin-messages` — every 5 min
- `sync-conversations` — every 10 min
- `purge-marketing-emails` — daily 2:30am UTC
- `renew-webhook-subscriptions` — every 6 hours

### Sequences
- `cleanup-stale-enrollments` — daily 8am UTC
- `check-connections` — every 30 min

### Resumes
- `reparse-resumes` — daily 2am UTC
- `reconcile-orphaned-resumes` — daily 12:30am UTC
- `backfill-resume-embeddings` — daily 1am UTC

### Calls (RingCentral)
- `poll-rc-calls` — every 5 min
- `drain-call-queue` — every 3 min

### Plumbing
- `unipile-resolve` (resolve-unipile-ids) — every 30 min

### Calendar (newly restored)
- `sync-outlook-events` — every 15 min

---

## 3. One-time manual run after deploy

- **`backfill-calendar-events`** — manually trigger ONCE to backfill all historical Outlook calendar events for Chris/Nancy. They'll show up in the unified activity feed (`v_person_activity` rows where `activity_type='meeting'`).

---

## 4. Webhook handlers (event-driven, no schedule)

These don't need cron schedules — they fire on incoming events. Just make sure they're DEPLOYED:
- `process-microsoft-event` (Outlook webhook)
- `process-unipile-event` (LinkedIn webhook)
- `process-ringcentral-event` (RingCentral webhook)

Verify the webhook endpoint URLs in your Trigger.dev dashboard match what Microsoft Graph / Unipile / RingCentral are calling.

---

## 5. Tasks that are CALLED BY OTHER TASKS (not scheduled, must be deployed)

These are invoked programmatically by webhooks/UI. No schedule needed but they MUST exist:
- `generate-joe-says` — called by 5 keep-list tasks (process-microsoft-event, send-message, process-ringcentral-event, resume-ingestion, process-unipile-event)
- `send-message` — called by sequence engine + UI
- `sequence-enrollment-init` — called by UI
- `process-call-deepgram` — called by RingCentral webhook
- `resume-ingestion` — called by upload UI
- `fetch-entity-history` — called when candidates are created

---

## Final task count

- Before: 43 tasks
- Deleted: 20
- Restored (calendar): 2
- **After: 25 tasks**

---

## Verification after cleanup

1. Open Trigger.dev dashboard → Runs tab
2. Wait 10 min
3. Filter by FAILED — there should be zero "task not found" errors
4. Spot-check `backfill-emails` ran successfully (most frequent task)
5. Spot-check `unipile-resolve` ran successfully (was failing on missing `candidate_channels` table before — should work now)
