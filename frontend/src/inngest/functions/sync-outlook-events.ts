import { inngest } from "../client";
import { runSyncOutlookEvents } from "../../server/sync-outlook-events";

/**
 * Every 30 min: pull 14d of forward calendar events from Microsoft
 * Graph + Unipile across all wired mailboxes, materialise meetings,
 * match attendees back to candidates/contacts.
 *
 * Multi-account fan-out is what makes this an Inngest fit (vs Vercel
 * cron). Single source of truth in `runSyncOutlookEvents` from the
 * Trigger.dev file. Cron schedule unchanged from original.
 */
export const syncOutlookEvents = inngest.createFunction(
  {
    id: "sync-outlook-events",
    retries: 1,
    triggers: [
      { cron: "*/30 * * * *" },
      { event: "outlook/sync-requested" },
    ],
  },
  async ({ step }) => {
    return step.run("run", () => runSyncOutlookEvents());
  },
);
