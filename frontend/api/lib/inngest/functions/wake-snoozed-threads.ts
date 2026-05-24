import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Every 5 minutes, find conversations whose snoozed_until has passed,
 * clear the snooze, and stamp woke_from_snooze_at so the inbox UI can
 * show a "just woke" banner. Also marks the thread unread so the user
 * notices it in their normal unread view.
 *
 * Idempotent: only matches rows where snoozed_until <= now() AND
 * snoozed_until IS NOT NULL, then nulls snoozed_until in the same
 * UPDATE, so a row can't be processed twice.
 */
export const wakeSnoozedThreads = inngest.createFunction(
  { id: "inbox-wake-snoozed-threads", name: "Inbox: wake snoozed threads" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("conversations")
      .update({
        snoozed_until: null,
        is_read: false,
        woke_from_snooze_at: new Date().toISOString(),
        status: null,
      } as any)
      .lte("snoozed_until", new Date().toISOString())
      .not("snoozed_until", "is", null)
      .select("id");

    if (error) {
      logger?.error("wake-snoozed-threads update failed", { error: error.message });
      throw new Error(error.message);
    }

    const count = data?.length ?? 0;
    if (count > 0) {
      logger?.info(`Woke ${count} snoozed threads`);
    }
    return { woken: count };
  },
);
