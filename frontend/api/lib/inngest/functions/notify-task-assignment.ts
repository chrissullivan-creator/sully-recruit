import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { sendSendoutEmail } from "../../../../src/server-lib/send-sendout-email.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Emails a recruiter when a to-do is assigned to them by someone else (e.g.
 * Chris flags missing candidate info from the stage-move drawer). The in-app
 * notification is written client-side by useCreateTask; this adds the email so
 * the assignee is alerted who created it, what to do, and about whom.
 *
 * The email is sent FROM the creator's mailbox (so it reads as "Chris asked
 * you to…"), reusing the same Microsoft Graph sender as client submissions.
 */
export const notifyTaskAssignment = inngest.createFunction(
  { id: "notify-task-assignment", name: "Email a recruiter when a to-do is assigned to them", retries: 2 },
  { event: "tasks/assignment.notify" },
  async ({ event, logger }) => {
    const { taskId } = event.data as { taskId: string };
    const supabase = getSupabaseAdmin();

    const { data: task, error } = await supabase
      .from("tasks")
      .select("id, title, description, due_date, created_by, assigned_to, task_links(entity_type, entity_id)")
      .eq("id", taskId)
      .maybeSingle();
    if (error) throw new Error(`task lookup failed: ${error.message}`);
    if (!task) {
      logger.warn("notify-task-assignment: task not found", { taskId });
      return { skipped: "not_found" };
    }
    const t = task as any;
    if (!t.assigned_to || t.assigned_to === t.created_by) {
      return { skipped: "self_or_unassigned" };
    }

    // Resolve assignee + creator from profiles (id, email, full_name).
    const ids = [t.assigned_to, t.created_by].filter(Boolean);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email, full_name")
      .in("id", ids);
    const byId = new Map((profiles || []).map((p: any) => [p.id, p]));
    const assignee = byId.get(t.assigned_to);
    const creator = byId.get(t.created_by);
    if (!assignee?.email) {
      logger.warn("notify-task-assignment: assignee has no email", { taskId, assignedTo: t.assigned_to });
      return { skipped: "no_assignee_email" };
    }
    if (!creator?.email) {
      // Can't send from a mailbox we can't resolve — the in-app notification
      // still covers it. Don't retry into failure.
      logger.warn("notify-task-assignment: creator has no sendable mailbox", { taskId, createdBy: t.created_by });
      return { skipped: "no_creator_mailbox" };
    }

    // Entity context — who/what the to-do is about.
    const links = (t.task_links || []) as { entity_type: string; entity_id: string }[];
    const contextParts: string[] = [];
    for (const l of links) {
      try {
        if (l.entity_type === "candidate" || l.entity_type === "contact") {
          const { data } = await supabase.from("people").select("full_name").eq("id", l.entity_id).maybeSingle();
          if ((data as any)?.full_name) contextParts.push(`${l.entity_type === "contact" ? "Contact" : "Candidate"}: ${(data as any).full_name}`);
        } else if (l.entity_type === "job") {
          const { data } = await supabase.from("jobs").select("title, company_name").eq("id", l.entity_id).maybeSingle();
          if ((data as any)?.title) contextParts.push(`Job: ${(data as any).title}${(data as any).company_name ? ` (${(data as any).company_name})` : ""}`);
        } else if (l.entity_type === "company") {
          const { data } = await supabase.from("companies").select("name").eq("id", l.entity_id).maybeSingle();
          if ((data as any)?.name) contextParts.push(`Company: ${(data as any).name}`);
        }
      } catch {
        // Best-effort context — never block the email.
      }
    }

    const creatorName = creator.full_name || "A teammate";
    const appBase = process.env.APP_BASE_URL || "https://app.sullyrecruit.com";
    const dueStr = t.due_date
      ? new Date(t.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null;

    const html = `
      <p>${escapeHtml(creatorName)} assigned you a new to-do in Sully Recruit.</p>
      <p style="font-size:16px;font-weight:600;margin:14px 0 4px">${escapeHtml(t.title || "To-do")}</p>
      ${t.description ? `<p style="white-space:pre-wrap;margin:0 0 8px">${escapeHtml(t.description)}</p>` : ""}
      ${contextParts.length ? `<p style="color:#555;margin:0 0 8px">${contextParts.map(escapeHtml).join("<br>")}</p>` : ""}
      ${dueStr ? `<p style="color:#555;margin:0 0 8px"><strong>Due:</strong> ${escapeHtml(dueStr)}</p>` : ""}
      <p style="margin-top:16px"><a href="${appBase}/tasks" style="color:#0B4F2F;font-weight:600;text-decoration:none">Open your to-dos →</a></p>
    `;

    try {
      await sendSendoutEmail(supabase, {
        userId: t.created_by,
        to: [assignee.email],
        subject: `New to-do from ${creatorName}: ${t.title || "Task"}`,
        html,
      });
    } catch (err: any) {
      // Don't fail the whole flow on a transient mailbox error past retries —
      // the in-app notification already reached the assignee.
      logger.warn("notify-task-assignment: email send failed", { taskId, error: err?.message });
      return { skipped: "send_failed", error: err?.message };
    }

    logger.info("notify-task-assignment: email sent", { taskId, to: assignee.email });
    return { sent: true };
  },
);
