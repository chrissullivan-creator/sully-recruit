# Inngest + Vercel Migration Roadmap

## Status (latest commit on `claude/inngest-migration-phase-1`)

**Code complete.** Every Trigger.dev task in `frontend/src/trigger/`
has been refactored into `runX` helpers + null-stub wrappers; the
matching Inngest function lives in `frontend/src/inngest/functions/`
and calls the same helper. **33 Inngest functions** registered.

The only Trigger.dev code that still does real work is the legacy v2
sequence engine triplet (`sequenceEnrollmentInit`,
`sequenceActionExecute`, `sequenceSweep`) which serves any sequences
still on `engine='trigger'`. Everything else either:
- never registers as a Trigger.dev task (wrapper = `null`), or
- exists as a wrapper that delegates to the same `runX` helper the
  Inngest function uses.

Phase 5b (`rm -rf frontend/src/trigger/` + drop the SDK dep) is held
back ONLY so the legacy enrollments under `engine='trigger'` can drain
or be migrated. Once every sequence is on `engine='inngest'`, the
directory can be deleted.

## Cutover playbook

1. **Set env vars** in BOTH Vercel (production) AND Trigger.dev:
   - `INNGEST_EVENT_KEY` — pulls from Inngest dashboard
   - `INNGEST_SIGNING_KEY` — for `/api/inngest` validation
2. **Deploy** the branch (merge to `main` → Vercel auto-deploys frontend
   AND Trigger.dev auto-deploys whatever's left in `frontend/src/trigger/`).
3. **Inngest discovers** the 33 functions automatically via the
   `/api/inngest` registration on first deploy. Watch the Inngest
   dashboard for the cron functions firing. Inngest crons replace
   Trigger.dev crons of the same id (the Trigger.dev wrappers we
   stubbed don't compete).
4. **Per-sequence flip** to Inngest:
   ```
   inngest.send({
     name: "sequence/migrate-to-inngest.requested",
     data: { sequenceId: "<uuid>", enrolledBy: "<operator-uuid>" },
   })
   ```
   The `migrate-sequence-to-inngest` Inngest function pauses the
   sequence, cancels pending Trigger.dev step_logs, flips
   `sequences.engine='inngest'`, resumes, and re-fires
   `sequence/enrolled` for every active enrollment so they pick up
   on the Inngest engine. Idempotent — safe to re-run.
5. **Verify** via Inngest dashboard that:
   - the 5-min `backfill-emails` and `backfill-linkedin-messages`
     crons are firing
   - `sequence-run` has runs for the sequence you flipped
   - no Trigger.dev tasks dispatch new runs (the dashboard should
     show the registered task list shrinking to just the 4 v2 sequence
     legacy tasks)
6. **Phase 5b** (after all sequences are on Inngest, ~24h watching):
   ```
   rm -rf frontend/src/trigger/
   rm frontend/trigger.config.ts
   # edit frontend/package.json: remove "@trigger.dev/sdk", "trigger:*" scripts
   # remove frontend/src/inngest/functions/*.ts imports of frontend/src/trigger/lib/*
   #   (move helpers to frontend/src/server/lib/ first)
   npm install
   ```
   The `runX` helpers will need to move with the libs they import
   (`unipile-v2`, `send-channels`, `merge-tags`, etc.) — currently
   nested under `src/trigger/lib/`. Move to `src/server/lib/` and
   update imports in the Inngest function files.

## Why

Trigger.dev costs scale with run volume; Inngest's event-based pricing is
cheaper at this volume (sweep fires every 3 min = ~14k runs/month before
counting the 60s backfills). More importantly, sequences map naturally to
Inngest's durable function model — `step.run`, `step.sleep`, and
`step.waitForEvent` collapse our hand-rolled `pending_connection` /
re-anchor / cron-sweep machinery into a single readable function body.

This migration moves heavy + workflow-shaped tasks to Inngest, simple crons
to Vercel cron, and keeps webhook ack endpoints on Vercel functions
(possibly Edge for latency).

## Categorization

### → Inngest (durable workflows, fan-out, long-running)

| Task | Reason |
|---|---|
| `sequence-scheduler` (init + execute + sweep) | Durable workflow per enrollment; `step.waitForEvent` replaces `pending_connection` cron |
| `send-message` | Chains to `generate-joe-says`; durable retry |
| `check-connections` | Cron + state transitions |
| `pending-connection-timeout` | Cron with bulk DB writes |
| `backfill-emails` (60s) | Multi-account fan-out |
| `backfill-linkedin-messages` (60s) | Multi-account fan-out |
| `backfill-calendar-events` | Long-running, multi-step |
| `backfill-resume-embeddings` | Long-running embeddings batch |
| `backfill-enrollment-init` | Replays init logic for stuck enrollments |
| `resume-ingestion` | Long-running (Vision API), retries |
| `recover-orphan-resumes` | Cron + storage scan + fan-out |
| `reconcile-orphaned-resumes` | Cron + state writes |
| `process-call-deepgram` | Long-running file processing |
| `extract-manual-call-intel` | AI call, retry semantics |
| `drain-call-queue` | Fan-out from queue |
| `sync-people-to-outlook` | Multi-row sync |
| `sync-conversations` | Multi-account sync |
| `sync-linkedin-invitations` (30m) | Cron + new-candidate creation |
| `generate-joe-says` | AI call ~30s, chained |
| `fetch-entity-history` | Multi-source aggregation |
| `webhook-microsoft` (deferred work) | Email parse + sentiment + enrollment stop |
| `webhook-unipile` (deferred work) | Same shape, multiple channels |
| `webhook-ringcentral` (deferred work) | SMS parse + intel |
| `webhook-subscription-renewal` | Microsoft Graph subscription rotation |
| `sync-outlook-events` (30m) | Fans out across Graph + Unipile accounts |
| `poll-rc-calls` | Fans out across RingCentral accounts |

### → Vercel Cron (simple, idempotent, short)

| Task | Reason |
|---|---|
| `cleanup-stale-enrollments` (daily) | Single DELETE, no fan-out |
| `sync-inmail-credits` (hourly) | Two API calls, idempotent stamp |
| `pipeline-health-digest` | Weekly digest send |
| `purge-marketing-emails` (daily) | Bulk Outlook folder cleanup |
| `sync-proxy-config` | Config refresh |
| `retry-stuck-call-transcripts` | Simple poll |

### → Vercel Functions (HTTP entrypoints; may be Edge)

| Endpoint | Runtime | Notes |
|---|---|---|
| `/api/webhooks/microsoft` | Node | Verifies signature, sends `microsoft/email-received` event to Inngest, returns 202 |
| `/api/webhooks/unipile` | Node | Same shape |
| `/api/webhooks/ringcentral` | Node | Same shape |
| `/api/track/email-open/:id` | **Edge** | 1×1 pixel, low-latency UPSERT to `sequence_step_logs.opened_at` |
| `/api/inngest` | Node | Inngest SDK serve handler |
| `/api/trigger-sequence-enroll` | Node | Replace with `inngest.send("sequence/enrolled")` |
| `/api/trigger-send-message` | Node | Replace with `inngest.send("message/send")` |
| `/api/trigger-extract-call-intel` | Node | Replace with `inngest.send("call/intel-requested")` |
| `/api/trigger-fetch-history` | Node | Replace with `inngest.send("entity/history-requested")` |
| `/api/trigger-generate-joe-says` | Node | Replace with `inngest.send("joe/says-requested")` |
| `/api/trigger-resume-ingestion` | Node | Replace with `inngest.send("resume/ingest-requested")` |
| `/api/trigger-sync-outlook` | Node | Replace with `inngest.send("outlook/sync-requested")` |
| `/api/replace-sequence-enrollments` | Node | Cancel runs + re-enqueue |

### Stay on Trigger.dev (none, ultimately)

We aim to fully decommission Trigger.dev. During migration, tasks remain in
parallel until each Inngest equivalent is verified.

## Phasing

Each phase = one branch, one PR.

### Phase 1 (this branch): Foundation + canonical pattern

1. Add `inngest` dep, `frontend/api/inngest.ts` route, `frontend/src/inngest/client.ts`
2. Migrate `sync-inmail-credits` as the canonical pattern (shortest, no
   fan-out). Disable the Trigger.dev version in the same commit.
3. Document env vars: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`.
4. Verify: build + dev server + (optionally) one production run.

### Phase 2: Sequence engine (highest risk, highest payoff)

1. Inngest function `sequence-run` per enrollment:
   - `step.run` per action send
   - `step.waitForEvent("linkedin/connection-accepted", ...)` replaces `pending_connection` polling
   - `step.sleep` replaces stamp-and-sweep
2. Maintain `sequence_step_logs` as a projection so the UI doesn't change.
3. Feature-flag rollout: new enrollments go to Inngest; existing Trigger.dev
   enrollments finish on Trigger.dev. Backfill cutover after 14 days.
4. Cancel `sequence-sweep-v2`, `sequence-action-execute`, `sequence-enrollment-init`.

### Phase 3: Webhooks + backfills

1. Convert webhook tasks to Inngest functions triggered by Vercel API routes.
2. Migrate backfills (`backfill-emails`, `backfill-linkedin-messages`, etc.).
3. Add Edge-runtime tracking pixel for email opens.

### Phase 4: Long-running jobs

1. Resume ingestion, call processing, Joe Says generation.
2. Each is independent; can move in any order.

### Phase 5: Decommission Trigger.dev

1. Remove `frontend/src/trigger/` directory, `trigger.config.ts`.
2. Drop `@trigger.dev/sdk` dep.
3. Remove `trigger:dev` / `trigger:deploy` scripts.

## Env var checklist

Production (Vercel):
- `INNGEST_EVENT_KEY` — fetched from Inngest dashboard
- `INNGEST_SIGNING_KEY` — for webhook validation

Dev (local):
- Inngest dev server picks up automatically when `npx inngest-cli@latest dev`
  is running and `/api/inngest` is reachable.

## Verification per task

For each migrated task:
1. Read the existing Trigger.dev task end-to-end before writing the Inngest version.
2. Match retry semantics (currently `maxAttempts: 2` or `3`).
3. Match cron expression exactly.
4. Confirm any chained tasks resolve to events.
5. Run locally against the Inngest dev server: send the trigger event, watch
   the run land, inspect step outputs.
6. Disable the Trigger.dev task only after parity is confirmed.
