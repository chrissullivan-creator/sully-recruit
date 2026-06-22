import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Re-pace every active enrollment of a sequence so step reorders, delay
 * changes, and weekdays-only flips propagate to people who are already
 * mid-flight. Cancels any pending step_logs (scheduled / pending_connection)
 * and re-fires `sequence/enrollment-init.requested` against the current
 * sequence config — same path a fresh enrollment takes.
 *
 * `sent` / `skipped` / `failed` rows are left alone so history sticks.
 * Post-Trigger.dev cutover: every sequence is `engine='inngest'`. The
 * old Trigger.dev fallback was deleted along with the SDK.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  const { sequence_id, enrolled_by, force_imminent, activate_paused } = req.body ?? {};
  if (!sequence_id || !enrolled_by) {
    return res.status(400).json({ error: "Missing sequence_id or enrolled_by" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    // activate_paused: start enrollments that were attached while the sequence
    // was a draft (status='paused' — e.g. BD-sequence contacts enrolled at
    // creation). Promote them to active and fire init so they schedule from
    // now. Deliberately does NOT touch already-active enrollments, so
    // activating a sequence never re-paces people who are already mid-flight.
    if (activate_paused) {
      const { data: paused, error: pausedErr } = await supabase
        .from("sequence_enrollments")
        .select("id, candidate_id, contact_id")
        .eq("sequence_id", sequence_id)
        .eq("status", "paused");
      if (pausedErr) throw pausedErr;
      if (!paused || paused.length === 0) {
        return res.status(200).json({ started: 0, message: "No paused enrollments" });
      }
      const pausedIds = paused.map((e) => e.id);
      const { error: promoteErr } = await supabase
        .from("sequence_enrollments")
        .update({ status: "active", updated_at: new Date().toISOString() } as any)
        .in("id", pausedIds);
      if (promoteErr) throw promoteErr;

      const tsSec = Math.floor(Date.now() / 1000);
      const events = paused.map((e) => ({
        id: `enrollment-init-${e.id}-activate-${tsSec}`,
        name: "sequence/enrollment-init.requested" as const,
        data: {
          enrollmentId: e.id,
          sequenceId: sequence_id,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy: enrolled_by,
        },
      }));
      const sent = await inngest.send(events);
      return res.status(200).json({ started: paused.length, engine: "inngest", task_run_ids: sent.ids });
    }

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
    // (sent / skipped / failed) intact — init will skip those actions.
    const { error: cancelErr } = await supabase
      .from("sequence_step_logs")
      .update({ status: "cancelled", skip_reason: "repaced", updated_at: new Date().toISOString() } as any)
      .in("enrollment_id", enrollmentIds)
      .in("status", ["scheduled", "in_flight", "pending_connection"]);

    if (cancelErr) throw cancelErr;

    // Don't reset enrolled_at — init now anchors unsent steps to the
    // last sent step's sent_at. Resetting would make step 1 fire again
    // immediately for anyone whose original step 1 already shipped.

    const tsSec = Math.floor(Date.now() / 1000);
    const events = enrollments.map((e) => ({
      // Distinct id per repace so the original `enrollment-init-{id}`
      // dedupe key in the Inngest log doesn't suppress this.
      id: `enrollment-init-${e.id}-repace-${tsSec}`,
      name: "sequence/enrollment-init.requested" as const,
      data: {
        enrollmentId: e.id,
        sequenceId: sequence_id,
        candidateId: e.candidate_id || undefined,
        contactId: e.contact_id || undefined,
        enrolledBy: enrolled_by,
      },
    }));
    const sent = await inngest.send(events);

    return res.status(200).json({
      repaced: enrollments.length,
      engine: "inngest",
      task_run_ids: sent.ids,
    });
  } catch (err: any) {
    console.error("replace-sequence-enrollments error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
