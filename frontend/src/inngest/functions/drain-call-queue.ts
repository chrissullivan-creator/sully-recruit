import { inngest } from "../client";
import { runDrainCallQueue } from "../../server/drain-call-queue";

/**
 * Every 3 min: drain the call processing queue — pick up pending
 * calls and dispatch them for transcription + analysis.
 */
export const drainCallQueue = inngest.createFunction(
  {
    id: "drain-call-queue",
    retries: 1,
    triggers: [
      { cron: "*/3 * * * *" },
      { event: "calls/drain-queue.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runDrainCallQueue()),
);
