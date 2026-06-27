import { calculatePostConnectionSendTime } from "./send-time-calculator.js";

/**
 * Shared LinkedIn connection-acceptance helpers.
 *
 * Two paths converge here:
 *   1. The check-connections Inngest cron, which polls Unipile for pending
 *      invites and promotes the parked follow-up steps once accepted.
 *   2. The send-time live guard in sequence-runner, which discovers — right
 *      before sending a connection request — that the recipient is ALREADY a
 *      1st-degree connection (they connected after enrollment). In that case we
 *      skip the duplicate invite and treat the connection as already accepted,
 *      so the same follow-up promotion has to run.
 *
 * Keeping both in one src/server-lib module means there's a single source of
 * truth for "what happens when a LinkedIn connection is (or already was)
 * accepted", and the api/ cron can import it (api/ → src/server-lib is the
 * established direction).
 */

/**
 * Promote any `pending_connection` step_logs for an enrollment to `scheduled`,
 * with a window-aware send time anchored on the acceptance timestamp.
 *
 * Ported verbatim from check-connections.ts so the cron and the live guard
 * compute identical follow-up times.
 */
export async function schedulePendingConnectionLogs(
  supabase: any,
  enrollmentId: string,
  acceptedAt: Date,
): Promise<number> {
  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (!enrollment) return 0;

  const sequence = enrollment.sequences;
  const senderUserId = sequence.sender_user_id || sequence.created_by;

  const { data: pendingLogs } = await supabase
    .from("sequence_step_logs")
    .select("id, sequence_actions!inner(base_delay_hours, delay_interval_minutes, jiggle_minutes)")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "pending_connection");
  if (!pendingLogs?.length) return 0;

  for (const log of pendingLogs as any[]) {
    const action = log.sequence_actions;
    const scheduledAt = await calculatePostConnectionSendTime(
      supabase,
      acceptedAt,
      Number(action.base_delay_hours) || 0,
      action.delay_interval_minutes || 0,
      action.jiggle_minutes || 0,
      sequence.send_window_start || "09:00",
      sequence.send_window_end || "18:00",
      senderUserId,
      sequence.timezone || undefined,
    );
    await supabase
      .from("sequence_step_logs")
      .update({ scheduled_at: scheduledAt.toISOString(), status: "scheduled" } as any)
      .eq("id", log.id);
  }
  return pendingLogs.length;
}

/**
 * Mark a LinkedIn connection as accepted for an enrollment and release the
 * follow-up steps. Flips the cached `is_connected` flag on the channel, clears
 * the enrollment's waiting state, and promotes any parked `pending_connection`
 * logs. Returns the number of follow-up steps promoted.
 *
 * `candidateId` is the unified person id (candidate_channels.candidate_id holds
 * the person id regardless of role).
 */
export async function markConnectionAccepted(
  supabase: any,
  enrollment: { id: string },
  candidateId: string,
  acceptedAt: Date = new Date(),
): Promise<number> {
  const iso = acceptedAt.toISOString();

  await supabase
    .from("candidate_channels")
    .update({ is_connected: true, connected_at: iso } as any)
    .eq("candidate_id", candidateId)
    .eq("channel", "linkedin");

  await supabase
    .from("sequence_enrollments")
    .update({
      waiting_for_connection_acceptance: false,
      linkedin_connection_status: "accepted",
      linkedin_connection_accepted_at: iso,
    } as any)
    .eq("id", enrollment.id);

  return schedulePendingConnectionLogs(supabase, enrollment.id, acceptedAt);
}
