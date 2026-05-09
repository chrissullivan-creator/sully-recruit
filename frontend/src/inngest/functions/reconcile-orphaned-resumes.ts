import { inngest } from "../client";
import { runReconcileOrphanedResumes } from "../../trigger/reconcile-orphaned-resumes";

/**
 * Every minute: find resumes parsed but not yet linked to a
 * candidate, run pdf-parse + AI fallback + voyage embedding to
 * extract identity, and either match them to an existing candidate or
 * create a new one. Per-tick batch capped at 4 to keep each sweep
 * under 10 minutes.
 */
export const reconcileOrphanedResumes = inngest.createFunction(
  {
    id: "reconcile-orphaned-resumes",
    retries: 1,
    triggers: [
      { cron: "* * * * *" },
      { event: "resumes/reconcile-orphaned.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runReconcileOrphanedResumes()),
);
