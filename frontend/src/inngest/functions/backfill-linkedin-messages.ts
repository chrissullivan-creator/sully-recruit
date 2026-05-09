import { inngest } from "../client";
import {
  runBackfillLinkedinMessages,
  LINKEDIN_BACKFILL_ACCOUNT_IDS,
} from "../../server/backfill-linkedin-messages";

/**
 * Every 5 min: pull recent LinkedIn chats for every recruiter account,
 * match attendees to candidates, log new messages.
 *
 * The Trigger.dev model fanned this out as 3 separate dashboard
 * schedules (one per recruiter, externalId = backfill-linkedin-{name}).
 * Inngest runs a single cron tick that loops over the configured
 * accounts in series. The per-account work happens inside its own
 * step.run so a single recruiter's failure doesn't restart the others.
 */
export const backfillLinkedinMessages = inngest.createFunction(
  {
    id: "backfill-linkedin-messages",
    retries: 1,
    triggers: [
      { cron: "*/5 * * * *" },
      { event: "linkedin/backfill-messages.requested" },
    ],
  },
  async ({ step, logger }) => {
    const results: Array<{ id: string; ok: boolean; error?: string | undefined }> = [];
    for (const externalId of LINKEDIN_BACKFILL_ACCOUNT_IDS) {
      const result = await step.run(`account-${externalId}`, async () => {
        try {
          await runBackfillLinkedinMessages(externalId);
          return { ok: true as const };
        } catch (err: any) {
          logger.warn("LinkedIn backfill failed for account (non-fatal)", {
            externalId, error: err?.message,
          });
          return { ok: false as const, error: err?.message };
        }
      });
      // step.run jsonifies the discriminated union; spread + cast so
      // the array element type stays uniform.
      const r = result as { ok: boolean; error?: string | undefined };
      results.push({ id: externalId, ok: r.ok, error: r.error });
    }
    return { accounts: results };
  },
);
