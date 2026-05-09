import { inngest } from "../client";
import { runBackfillResumeEmbeddings } from "../../trigger/backfill-resume-embeddings";

/**
 * Every 6 hours: build full_profile embeddings for parsed resumes
 * that don't have one yet. Long-running (Voyage AI per resume; batch
 * of 25). Was originally "as needed" on Trigger.dev; the 6-hour cron
 * keeps the backlog drained without flooding the API.
 */
export const backfillResumeEmbeddings = inngest.createFunction(
  {
    id: "backfill-resume-embeddings",
    retries: 1,
    triggers: [
      { cron: "0 */6 * * *" },
      { event: "resumes/backfill-embeddings.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runBackfillResumeEmbeddings()),
);
