import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Fires the `tasks/assignment.notify` Inngest event. The function in
 * api/lib/inngest/functions/notify-task-assignment.ts emails the assignee (from
 * the creator's mailbox) when a to-do is assigned to someone other than its
 * creator. Called best-effort by useCreateTask after a cross-recruiter assign.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  try {
    const { taskId } = req.body || {};
    if (!taskId) {
      return res.status(400).json({ error: "Missing required field: taskId" });
    }
    const { ids } = await inngest.send({
      name: "tasks/assignment.notify",
      data: { taskId },
    });
    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger notify-task-assignment error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
