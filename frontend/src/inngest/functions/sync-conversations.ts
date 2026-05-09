import { inngest } from "../client";
import { runSyncConversations } from "../../server/sync-conversations";

/**
 * Every 2 hours: pull conversation lists for every active LinkedIn
 * account and persist message history. Multi-account fan-out runs
 * inside the helper (each account's chats sync sequentially within a
 * single tick).
 */
export const syncConversations = inngest.createFunction(
  {
    id: "sync-conversations",
    retries: 1,
    triggers: [
      { cron: "0 0/2 * * *" },
      { event: "linkedin/sync-conversations.requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runSyncConversations()),
);
