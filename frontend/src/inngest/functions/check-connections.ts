import { inngest } from "../client";
import { runCheckConnections } from "../../trigger/check-connections";

/**
 * 4-hourly polling fallback for missed `connection_accepted` Unipile
 * webhooks. Without this, an enrollment with a missed webhook stays
 * parked in pending_connection forever and the next message step
 * never fires.
 *
 * Single source of truth lives in the Trigger.dev file as
 * `runCheckConnections`.
 *
 * Cron expression matches the Trigger.dev original ("0 0/4 * * *"
 * every 4 hours) so the schedule doesn't shift on cutover.
 */
export const checkConnections = inngest.createFunction(
  {
    id: "check-connections",
    retries: 1,
    triggers: [
      { cron: "0 0/4 * * *" },
      { event: "linkedin/check-connections.requested" },
    ],
  },
  async ({ step }) => {
    return step.run("run", () => runCheckConnections());
  },
);
