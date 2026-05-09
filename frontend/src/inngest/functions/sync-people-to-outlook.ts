import { inngest } from "../client";
import { runSyncPeopleToOutlook } from "../../trigger/sync-people-to-outlook";

/**
 * Every 30 min: push newly added / recently updated people to Outlook
 * Contacts so the recruiter sees them in their address book.
 */
export const syncPeopleToOutlook = inngest.createFunction(
  {
    id: "sync-people-to-outlook",
    retries: 1,
    triggers: [
      { cron: "*/30 * * * *" },
      { event: "outlook/sync-people.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runSyncPeopleToOutlook()),
);
