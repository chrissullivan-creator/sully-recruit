import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../src/inngest/client";
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

    // Hand each enrollment to whichever engine owns the sequence. Read
    // the engine column once; all enrollments on a sequence share an
    // engine because it lives on `sequences`, not enrollments.
    const { data: seqRow } = await supabase
      .from("sequences")
      .select("engine")
      .eq("id", sequence_id)
      .maybeSingle();
    const engine = ((seqRow as any)?.engine || "trigger") as "trigger" | "inngest";

    const handles: string[] = [];
    if (engine === "inngest") {
      const events = enrollments.map((e) => ({
        // Repace = brand-new run for the enrollment; include 'repace' +
        // a timestamp in the id so it's distinct from the original
        // seq-enrolled-{enrollmentId} dedup key.
        id: `seq-enrolled-${e.id}-repace-${Math.floor(Date.now() / 1000)}`,
        name: "sequence/enrolled" as const,
        data: {
          enrollmentId: e.id,
          sequenceId: sequence_id,
          candidateId: e.candidate_id || undefined,
          contactId: e.contact_id || undefined,
          enrolledBy: enrolled_by,
        },
      }));
      const sent = await inngest.send(events);
      handles.push(...sent.ids);
    } else {
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
    }

    return res.status(200).json({
      repaced: enrollments.length,
      engine,
      task_run_ids: handles,
    });
  } catch (err: any) {
    console.error("replace-sequence-enrollments error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
