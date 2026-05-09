import { task } from "@trigger.dev/sdk/v3";
import { inngest } from "../../api/lib/inngest/client.js";

interface ResumeIngestionPayload {
  resumeId: string;
  candidateId: string;
  filePath: string;
  fileName: string;
}

/**
 * Trigger.dev wrapper around the Inngest `resume-ingestion` function.
 *
 * The body lives in `api/lib/inngest/functions/resume-ingestion.ts`.
 * This wrapper exists so any caller still using
 * `resumeIngestion.trigger(...)` (the Trigger.dev `webhook-microsoft`
 * task on `main`, plus any frontend route that hasn't migrated yet)
 * keeps working — it dispatches an Inngest event instead of doing the
 * work directly.
 *
 * Will be deleted alongside the Trigger.dev SDK once every caller has
 * been migrated to send the `ai/resume-ingestion.requested` event
 * directly.
 */
export const resumeIngestion = task({
  id: "resume-ingestion",
  retry: { maxAttempts: 1 },
  run: async (payload: ResumeIngestionPayload) => {
    const { ids } = await inngest.send({
      name: "ai/resume-ingestion.requested",
      data: payload,
    });
    return { dispatched: true, eventId: ids[0] };
  },
});
