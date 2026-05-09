import { inngest } from "../client";
import { runPoll } from "../../server/poll-rc-calls";

/**
 * Every 5 min: poll RingCentral call logs across every wired account,
 * insert any new ones, dispatch transcription. Lookback window is
 * configurable via event payload (defaults to 10 min for the cron).
 */
export const pollRcCalls = inngest.createFunction(
  {
    id: "poll-rc-calls",
    retries: 1,
    triggers: [
      { cron: "*/5 * * * *" },
      { event: "ringcentral/poll-calls.requested" },
    ],
  },
  async ({ event, step }) => {
    const minutes = (event.data as { lookback_minutes?: number })?.lookback_minutes ?? 10;
    return step.run("run", () => runPoll(minutes));
  },
);
