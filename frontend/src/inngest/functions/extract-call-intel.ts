import { inngest } from "../client";
import { runExtractManualCallIntel } from "../../trigger/extract-manual-call-intel";

/**
 * Inngest port of extract-manual-call-intel.
 * Single source of truth for the logic lives in the Trigger.dev file.
 */
export const extractCallIntel = inngest.createFunction(
  {
    id: "extract-call-intel",
    retries: 2,
    triggers: [{ event: "call/intel-requested" }],
    concurrency: [{ key: "event.data.callLogId", limit: 1 }],
  },
  async ({ event, step }) => {
    const { callLogId } = event.data as { callLogId: string };
    if (!callLogId) return { skipped: true, reason: "missing_callLogId" };
    return step.run("run", () => runExtractManualCallIntel({ callLogId }));
  },
);
