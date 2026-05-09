import { inngest } from "../client";
import { runRecoverOrphanResumes } from "../../server/recover-orphan-resumes";

/**
 * On-demand recovery of resumes that exist in the storage bucket but
 * have no matching `resumes` row (e.g. failed mid-upload or DB
 * trigger backfilled out of order). The reconcile-orphaned-resumes
 * cron handles the steady-state path; this is the operator's
 * "rescue" knob for one-off cleanups.
 *
 * Fired from the Settings page "Recover orphan resumes" button.
 */
export const recoverOrphanResumes = inngest.createFunction(
  {
    id: "recover-orphan-resumes",
    retries: 1,
    triggers: [{ event: "resumes/recover-orphan.requested" }],
  },
  async ({ event, step }) => {
    const payload = (event.data ?? {}) as Parameters<typeof runRecoverOrphanResumes>[0];
    return step.run("run", () => runRecoverOrphanResumes(payload));
  },
);
