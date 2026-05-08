import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";

/**
 * Re-pace every active enrollment of a sequence so step reorders, delay
 * changes, and weekdays-only flips propagate to people who are already
 * mid-flight. Cancels any pending step_logs (scheduled / pending_connection)
 * and re-runs `sequence-enrollment-init` against the current sequence
 * config — same path a fresh enrollment takes.
 *
 * `sent` / `skipped` / `failed` rows are left alone so history sticks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  const { sequence_id, enrolled_by, force_imminent } = req.body ?? {};
  if (!sequence_id || !enrolled_by) {
    return res.status(400).json({ error: "Missing sequence_id or enrolled_by" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { data: enrollments, error: enrollErr } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id, contact_id")
      .eq("sequence_id", sequence_id)
      .eq("status", "active");

    if (enrollErr) throw enrollErr;
    if (!enrollments || enrollments.length === 0) {
      return res.status(200).json({ repaced: 0, message: "No active enrollments" });
    }

    const enrollmentIds = enrollments.map((e) => e.id);

    // Safeguard: if any pending step_log is set to fire within the next 10
    // minutes, the sweep may already have claimed it. Cancelling under
    // that race risks losing a send (or worse, double-sending if the
    // claim already went out). Surface a confirmation to the caller and
    // require an explicit `force_imminent: true` to proceed.
    if (!force_imminent) {
      const tenMinFromNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { count: imminent } = await supabase
        .from("sequence_step_logs")
        .select("id", { count: "exact", head: true })
        .in("enrollment_id", enrollmentIds)
        .in("status", ["scheduled", "in_flight"])
        .lte("scheduled_at", tenMinFromNow);
      if ((imminent ?? 0) > 0) {
        return res.status(409).json({
          imminent_count: imminent,
          message: `${imminent} send${imminent === 1 ? "" : "s"} fire within 10 minutes — re-pace would race the sweep. Re-send with force_imminent=true to override.`,
        });
      }
    }

    // Cancel pending step_logs (scheduled + pending_connection) so the
    // next enrollment-init run starts from a clean slate. Keep history
    // (sent / skipped / failed) intact.
    const { error: cancelErr } = await supabase
      .from("sequence_step_logs")
      .update({ status: "cancelled", skip_reason: "repaced", updated_at: new Date().toISOString() } as any)
      .in("enrollment_id", enrollmentIds)
      .in("status", ["scheduled", "in_flight", "pending_connection"]);

    if (cancelErr) throw cancelErr;

    // Reset enrolled_at to NOW so cumulative delays restart from this
    // moment. Without this the engine would re-pace using the original
    // enrolled_at and step 1 (delay 0) would fire immediately.
    const nowIso = new Date().toISOString();
    await supabase
      .from("sequence_enrollments")
      .update({ enrolled_at: nowIso } as any)
      .in("id", enrollmentIds);

    // Hand each enrollment to sequence-enrollment-init.
    const handles: string[] = [];
    for (const e of enrollments) {
      const handle = await tasks.trigger("sequence-enrollment-init", {
        enrollmentId: e.id,
        sequenceId: sequence_id,
        candidateId: e.candidate_id || undefined,
        contactId: e.contact_id || undefined,
        enrolledBy: enrolled_by,
      });
      handles.push(handle.id);
    }

    return res.status(200).json({
      repaced: enrollments.length,
      task_run_ids: handles,
    });
  } catch (err: any) {
    console.error("replace-sequence-enrollments error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
