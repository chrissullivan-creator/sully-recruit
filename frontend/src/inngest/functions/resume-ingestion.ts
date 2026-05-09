import { inngest } from "../client";
import { runResumeIngestion } from "../../server/resume-ingestion";

/**
 * Inngest port of resume-ingestion. Single source of truth lives in
 * the Trigger.dev file as `runResumeIngestion`.
 *
 * Long-running on the AI cascade (Vision parse + extract + embedding).
 * Per-resume concurrency=1 prevents a duplicate invocation from
 * processing the same blob twice if the upload route retries.
 */
export const resumeIngestion = inngest.createFunction(
  {
    id: "resume-ingestion",
    retries: 3,
    triggers: [{ event: "resume/ingest-requested" }],
    concurrency: [{ key: "event.data.resumeId", limit: 1 }],
  },
  async ({ event, step }) => {
    const payload = event.data as Parameters<typeof runResumeIngestion>[0];
    if (!payload?.resumeId) return { skipped: true, reason: "missing_resumeId" };
    return step.run("run", () => runResumeIngestion(payload));
  },
);
