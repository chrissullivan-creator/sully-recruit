import { inngest } from "../client";
import { runPendingConnectionTimeout } from "../../trigger/sequence-scheduler";

/**
 * Daily 02:00 UTC: cancel any pending_connection step_log older than
 * PENDING_CONNECTION_TTL_DAYS (currently 21d). Without this, an
 * unaccepted invite leaves the enrollment perpetually "incomplete"
 * and `checkSequenceComplete` never closes it out.
 *
 * Single source of truth in `runPendingConnectionTimeout` from the
 * Trigger.dev file.
 *
 * NOTE: New Inngest sequence-run enrollments handle the same cleanup
 * inline via `step.waitForEvent("linkedin/connection-accepted",
 * { timeout: "21d" })`. This cron only matters for legacy Trigger.dev
 * enrollments still parked in pending_connection.
 */
export const pendingConnectionTimeout = inngest.createFunction(
  {
    id: "sequence-pending-connection-timeout",
    retries: 1,
    triggers: [
      { cron: "0 2 * * *" },
      { event: "sequence/pending-connection-timeout.requested" },
    ],
  },
  async ({ step }) => {
    return step.run("run", () => runPendingConnectionTimeout());
  },
);
