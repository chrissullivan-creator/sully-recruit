/**
 * MIGRATED to Inngest — see frontend/src/inngest/functions/sync-inmail-credits.ts
 *
 * The schedule (`0 * * * *`) and per-account fetch logic now run as an
 * Inngest function. This file remains as a stub so Trigger.dev's task
 * registry doesn't surface a missing-task error during the cutover
 * window; when Phase 5 (decommission Trigger.dev) lands, this file is
 * deleted along with the rest of frontend/src/trigger/.
 *
 * Do NOT add a new schedules.task() here — the Inngest version owns the
 * cron now. Running both would double-write inmail_credits_remaining
 * (idempotent but wasteful API calls).
 */
export const syncInmailCredits = null;
