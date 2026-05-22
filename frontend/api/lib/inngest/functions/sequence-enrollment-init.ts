import { inngest } from "../client.js";
import { runSequenceEnrollmentInit } from "../../../../src/server-lib/enrollment-init-runner.js";

/**
 * Inngest function for `sequence/enrollment-init.requested`. The body
 * lives in `src/server-lib/enrollment-init-runner.ts` — recipient
 * pre-flight, pre-skip rules, window-aware scheduled_at via
 * calculateSendTime, idempotency gate against existing non-cancelled
 * step_logs.
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
