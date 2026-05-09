import { inngest } from "../client";
import { runSyncLinkedinInvitations } from "../../trigger/sync-linkedin-invitations";

/**
 * Every 30 min: poll Unipile for inbound LinkedIn invitations across
 * every active LinkedIn account, materialise them as candidates, and
 * keep `linkedin_invitations` authoritative.
 *
 * Single source of truth lives in the Trigger.dev file as
 * `runSyncLinkedinInvitations`. Cron schedule matches the Trigger.dev
 * original exactly.
 */
export const syncLinkedinInvitations = inngest.createFunction(
  {
    id: "sync-linkedin-invitations",
    retries: 1,
    triggers: [
      { cron: "*/30 * * * *" },
      { event: "linkedin/sync-invitations.requested" },
    ],
  },
  async ({ step }) => {
    return step.run("run", () => runSyncLinkedinInvitations());
  },
);
