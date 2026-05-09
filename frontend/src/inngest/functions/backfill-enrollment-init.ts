import { inngest } from "../client";
import { runBackfillEnrollmentInit } from "../../server/backfill-enrollment-init";

/**
 * Every 10 min: find sequence_enrollments that were inserted but
 * never got their step_logs pre-scheduled (e.g. because the
 * post-insert trigger task failed) and re-fire enrollment-init for
 * them. Stops new enrollments from sitting dormant.
 *
 * NOTE: New Inngest sequence-run enrollments don't pre-schedule rows
 * the same way (the function IS the schedule), so this backfill only
 * matters for legacy Trigger.dev enrollments. After the cutover
 * window passes (engine='trigger' enrollments all completed) this
 * function can also be retired.
 */
export const backfillEnrollmentInit = inngest.createFunction(
  {
    id: "backfill-enrollment-init",
    retries: 1,
    triggers: [
      { cron: "*/10 * * * *" },
      { event: "sequence/backfill-enrollment-init.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runBackfillEnrollmentInit()),
);
