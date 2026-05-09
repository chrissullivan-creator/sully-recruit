import { inngest } from "../client";
import { runBackfillEmails } from "../../trigger/backfill-emails";

/**
 * Every 5 min: pull last 3 days of email from each wired Microsoft
 * Graph mailbox, match senders to candidates/contacts, insert any
 * missing inbound rows. Acts as the safety net for the realtime
 * webhook subscription — if a notification gets dropped or the
 * subscription expires, this backfill catches it within 5 minutes.
 */
export const backfillEmails = inngest.createFunction(
  {
    id: "backfill-emails",
    retries: 1,
    triggers: [
      { cron: "*/5 * * * *" },
      { event: "emails/backfill-requested" },
    ],
  },
  async ({ step }) => step.run("run", () => runBackfillEmails()),
);
