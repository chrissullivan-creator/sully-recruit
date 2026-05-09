import { inngest } from "../client";
import { runCleanupStaleEnrollments } from "../../trigger/cleanup-stale-enrollments";

/**
 * Daily 05:00 UTC: cancel pending step_logs whose connection request
 * was withdrawn / inactive too long. Idempotent.
 */
export const cleanupStaleEnrollments = inngest.createFunction(
  {
    id: "cleanup-stale-enrollments",
    retries: 1,
    triggers: [
      { cron: "0 5 * * *" },
      { event: "sequence/cleanup-stale-enrollments.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runCleanupStaleEnrollments()),
);
