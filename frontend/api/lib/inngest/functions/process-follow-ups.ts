import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Hourly: find conversations whose follow_up_at has passed AND the
 * recipient hasn't replied since the reminder was set. Mark the
 * thread unread so it resurfaces in the user's main inbox, and stamp
 * follow_up_triggered_at so we don't fire it twice for the same
 * reminder window.
 *
 * "Hasn't replied since the reminder was set" = there is no inbound
 * message on this conversation with sent_at > follow_up_at_set_at.
 * If the candidate did reply, the reminder is cancelled silently
 * (we still stamp follow_up_triggered_at and clear follow_up_at).
 */
export const processFollowUps = inngest.createFunction(
  { id: "inbox-process-follow-ups", name: "Inbox: process follow-up reminders" },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Pull due reminders that haven't been triggered yet.
    const { data: due, error: dueErr } = await supabase
      .from("conversations")
      .select("id, follow_up_at, follow_up_at_set_at")
      .lte("follow_up_at", now)
      .is("follow_up_triggered_at", null)
      .not("follow_up_at", "is", null);

    if (dueErr) {
      logger?.error("process-follow-ups query failed", { error: dueErr.message });
      throw new Error(dueErr.message);
    }
    if (!due || due.length === 0) {
      return { processed: 0, surfaced: 0, cancelled: 0 };
    }

    let surfaced = 0;
    let cancelled = 0;

    for (const row of due) {
      const setAt = row.follow_up_at_set_at ?? row.follow_up_at;

      // Did anyone reply since the reminder was set?
      const { count: replyCount } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", row.id)
        .eq("direction", "inbound")
        .gte("sent_at", setAt);

      const reply = (replyCount ?? 0) > 0;

      // In either case stamp follow_up_triggered_at + clear follow_up_at
      // so we don't fire again. Only mark unread if no reply happened
      // (otherwise the reminder is moot — they replied, no nudge needed).
      const patch: Record<string, unknown> = {
        follow_up_triggered_at: now,
        follow_up_at: null,
      };
      if (!reply) {
        patch.is_read = false;
        surfaced += 1;
      } else {
        cancelled += 1;
      }

      const { error: updErr } = await supabase
        .from("conversations")
        .update(patch as any)
        .eq("id", row.id);

      if (updErr) {
        logger?.error("process-follow-ups update failed", {
          conversation_id: row.id,
          error: updErr.message,
        });
      }
    }

    logger?.info(`Processed ${due.length} follow-ups (${surfaced} surfaced, ${cancelled} cancelled)`);
    return { processed: due.length, surfaced, cancelled };
  },
);
