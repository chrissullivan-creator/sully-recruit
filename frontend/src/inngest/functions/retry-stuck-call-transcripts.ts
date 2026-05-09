import { inngest } from "../client";
import { runRetryStuckCallTranscripts } from "../../trigger/retry-stuck-call-transcripts";

/**
 * Every 15 min: find call_logs whose Deepgram transcription got stuck
 * (5 min .. 7 days old, no transcript) and re-fire processing.
 */
export const retryStuckCallTranscripts = inngest.createFunction(
  {
    id: "retry-stuck-call-transcripts",
    retries: 1,
    triggers: [
      { cron: "*/15 * * * *" },
      { event: "calls/retry-stuck-transcripts.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runRetryStuckCallTranscripts()),
);
