import { inngest } from "../client";
import { reclassifyOnce } from "../../trigger/reclassify-linkedin-chats";

/**
 * Daily 06:00 UTC: re-classify recently-arrived LinkedIn chats whose
 * content_type column wasn't stamped at receive time (older rows pre-
 * webhook-content-type-capture). Skips already-classified rows.
 */
export const reclassifyLinkedinChatsDaily = inngest.createFunction(
  {
    id: "reclassify-linkedin-chats-daily",
    retries: 1,
    triggers: [
      { cron: "0 6 * * *" },
      { event: "linkedin/reclassify-chats.requested" },
    ],
  },
  async ({ step, event }) => {
    const limit = (event.data as { limit?: number })?.limit ?? 1500;
    return step.run("run", () => reclassifyOnce({ limit }));
  },
);
