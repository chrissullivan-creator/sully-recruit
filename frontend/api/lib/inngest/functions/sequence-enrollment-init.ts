import { inngest } from "../client.js";
import { runSequenceEnrollmentInit } from "../../../../src/trigger/sequence-scheduler.js";

/**
 * Inngest mirror of Trigger.dev's `sequenceEnrollmentInit` task. The
 * body is shared via `runSequenceEnrollmentInit` in
 * `src/trigger/sequence-scheduler.ts` — same recipient pre-flight,
 * pre-skip rules, scheduled_at calculation (window-aware via
 * calculateSendTime), and idempotency gate (skips actions that already
 * have non-cancelled step_logs from a prior run / re-pace).
 *
 * `retries: 3` matches Trigger.dev's `maxAttempts: 3` so transient
 * errors have the same retry budget on either engine.
 *
 * Concurrency keyed by enrollmentId so a duplicate request for the
 * same enrollment (the api/trigger-sequence-enroll route retrying on
 * a flaky network, for example) doesn't double-schedule. The runner
 * is internally idempotent against existing non-cancelled rows but
 * the concurrency guard saves a round-trip.
 */
export const sequenceEnrollmentInit = inngest.createFunction(
  {
    id: "sequence-enrollment-init",
    name: "Initialize sequence enrollment (Inngest)",
    retries: 3,
    concurrency: [{ key: "event.data.enrollmentId", limit: 1 }],
  },
  { event: "sequence/enrollment-init.requested" },
  async ({ event }) => {
    return runSequenceEnrollmentInit(event.data);
  },
);
