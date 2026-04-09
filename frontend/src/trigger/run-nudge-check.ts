import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

const STAGNATION_DAYS = 7;
const MAX_NUDGE_ITEMS = 20;

/**
 * Scheduled task: scan pipeline for stagnant candidates,
 * create follow-up tasks, and email Chris a nudge summary.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: run-nudge-check
 *   Cron: 0 14 * * 1-5 (weekdays at 2 PM UTC / 9 AM ET)
 */
export const runNudgeCheck = schedules.task({
  id: "run-nudge-check",
  run: async () => {
    const supabase = getSupabaseAdmin();
    const chrisEmail = "chris.sullivan@emeraldrecruit.com";

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STAGNATION_DAYS);
    cutoff.setHours(0, 0, 0, 0);

    // Find stagnant candidates
    const { data: stagnant } = await supabase
      .from("candidates")
      .select("id, full_name, title, company, status, owner_id, updated_at")
      .in("status", ["new", "reached_out", "back_of_resume"])
      .lt("updated_at", cutoff.toISOString())
      .limit(50);

    if (!stagnant?.length) {
      logger.info("No stagnant candidates found");
      return { stagnant_candidates: 0, tasks_created: 0, nudge_sent: false };
    }

    // Find Chris's user ID
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("email", chrisEmail)
      .limit(1);

    const chrisId = profiles?.[0]?.id;

    // Create follow-up tasks
    let tasksCreated = 0;
    const nudgeItems: string[] = [];

    for (const c of stagnant.slice(0, MAX_NUDGE_ITEMS)) {
      const name = c.full_name || "Unknown";
      const title = c.title || "";
      const company = c.company || "";
      nudgeItems.push(`\u2022 ${name} (${title} at ${company}) \u2014 status: ${c.status}`);

      if (chrisId) {
        const { error } = await supabase.from("tasks").insert({
          title: `Follow up with ${name}`,
          description: `No activity in ${STAGNATION_DAYS}+ days. ${title} at ${company}. Current status: ${c.status}`,
          priority: "high",
          due_date: new Date().toISOString().slice(0, 10),
          assigned_to: chrisId,
          created_by: chrisId,
        });
        if (!error) tasksCreated++;
      }
    }

    // Send nudge email via send-message edge function
    if (nudgeItems.length > 0 && chrisId) {
      const emailBody =
        `Hi Chris,\n\n${stagnant.length} candidates haven't had activity in ${STAGNATION_DAYS}+ days:\n\n` +
        nudgeItems.join("\n") +
        `\n\nI've created ${tasksCreated} follow-up tasks in your To-Do's.\n\n\u2014 Joe (Sully Recruit AI)`;

      const { error } = await supabase.functions.invoke("send-message", {
        body: {
          channel: "email",
          to: chrisEmail,
          subject: `${stagnant.length} candidates need follow-up`,
          body: emailBody,
        },
      });

      if (error) {
        logger.warn("Nudge email failed", { error: error.message });
      }
    }

    const result = {
      stagnant_candidates: stagnant.length,
      tasks_created: tasksCreated,
      nudge_sent: nudgeItems.length > 0,
    };

    logger.info("Nudge check complete", result);
    return result;
  },
});
