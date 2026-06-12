import { getSupabaseAdmin } from "./supabase.js";
import { calculateSendTime } from "./send-time-calculator.js";

// Inlined from `@/components/sequences/sequenceBranches` so Vercel's
// Node function bundler doesn't have to resolve the `@/` Vite path
// alias (it doesn't, and it breaks at runtime with ERR_MODULE_NOT_FOUND).
// Branch ordering: branch_a sorts before branch_b; un-branched steps
// fall back to node_order.
const BRANCH_SORT_ORDER: Record<string, number> = { branch_a: 0, branch_b: 1 };

function compareSequenceNodes(
  a: { branch_id?: string | null; branch_step_order?: number | null; node_order?: number | null },
  b: { branch_id?: string | null; branch_step_order?: number | null; node_order?: number | null },
) {
  const branchA = a?.branch_id === "branch_a" || a?.branch_id === "branch_b" ? a.branch_id : null;
  const branchB = b?.branch_id === "branch_a" || b?.branch_id === "branch_b" ? b.branch_id : null;

  if (branchA && branchB && branchA !== branchB) {
    return BRANCH_SORT_ORDER[branchA] - BRANCH_SORT_ORDER[branchB];
  }
  if (branchA && branchB) {
    return (
      (Number(a?.branch_step_order) || Number(a?.node_order) || 0) -
      (Number(b?.branch_step_order) || Number(b?.node_order) || 0)
    );
  }
  return (Number(a?.node_order) || 0) - (Number(b?.node_order) || 0);
}

export interface EnrollmentInitPayload {
  enrollmentId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

/**
 * Engine-neutral run body for `sequence/enrollment-init.requested`.
 *
 * Pre-schedules every `sequence_step_logs` row this enrollment will
 * need. Idempotent against existing non-cancelled rows so re-paces and
 * retries don't double-insert.
 *
 * Pre-flight rules:
 *   - Pre-skip if recipient lacks the channel field (no email → skip
 *     email; no linkedin_url → skip linkedin_*; no phone → skip sms).
 *   - Pre-skip linkedin_connection when candidate_channels.is_connected.
 *   - Park linkedin_message as pending_connection when not connected
 *     yet — webhook + check-connections promote to scheduled on accept.
 *
 * Cursor model: each step's `base_delay_hours` is a gap from the
 * previous SCHEDULED step. Pre-skipped steps don't advance the cursor,
 * so the next eligible step takes the open slot.
 */
export async function runSequenceEnrollmentInit(payload: EnrollmentInitPayload) {
  const supabase = getSupabaseAdmin();

  const { data: enrollment } = await supabase
    .from("sequence_enrollments")
    .select("*")
    .eq("id", payload.enrollmentId)
    .single();

  if (!enrollment || enrollment.status !== "active") {
    return { action: "skipped", reason: `enrollment_status_${enrollment?.status}` };
  }

  const { data: sequence } = await supabase
    .from("sequences")
    .select("*")
    .eq("id", payload.sequenceId)
    .single();

  if (!sequence) {
    return { action: "error", reason: "sequence_not_found" };
  }

  const { data: nodes } = await supabase
    .from("sequence_nodes")
    .select("id, node_order, branch_id, branch_step_order, sequence_actions(*)")
    .eq("sequence_id", payload.sequenceId);

  if (!nodes || nodes.length === 0) {
    return { action: "error", reason: "no_nodes" };
  }

  const orderedNodes = [...nodes].sort(compareSequenceNodes);
  const senderUserId = sequence.sender_user_id || sequence.created_by || payload.enrolledBy;
  const enrolledAt = new Date(enrollment.enrolled_at);
  let scheduled = 0;
  let pendingConnection = 0;
  let preSkipped = 0;

  // Idempotency for re-pace: load every non-cancelled step_log this
  // enrollment already has. Cancelled logs were cleared by the
  // re-pace path and are eligible for re-scheduling. Anything else
  // (sent / skipped / failed / pending_connection that's still live)
  // is terminal — we must not insert a duplicate.
  const { data: existingLogs } = await supabase
    .from("sequence_step_logs")
    .select("action_id, status, sent_at, scheduled_at")
    .eq("enrollment_id", payload.enrollmentId)
    .not("status", "eq", "cancelled");
  const existingByAction = new Map<string, { status: string; sent_at: string | null; scheduled_at: string | null }>();
  for (const log of (existingLogs || []) as any[]) {
    if (log.action_id) existingByAction.set(log.action_id, log);
  }

  // Pre-fetch the recipient's contact fields once so we can pre-skip
  // steps the recipient can't receive without round-tripping at each step.
  const recipientId = enrollment.candidate_id || enrollment.contact_id;
  let recipientEmail: string | null = null;
  let recipientLinkedin: string | null = null;
  let recipientPhone: string | null = null;
  let recipientLinkedinConnected = false;
  if (recipientId) {
    const { data: person } = await supabase
      .from("people")
      .select("type, primary_email, work_email, personal_email, phone, linkedin_url, do_not_contact")
      .eq("id", recipientId)
      .maybeSingle();

    // Compliance guard — never schedule anything for a suppressed person.
    // Stop the enrollment so it doesn't sit "active" forever.
    if (person?.do_not_contact) {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "stopped", stop_trigger: "do_not_contact", stop_reason: "do_not_contact", stopped_at: new Date().toISOString() })
        .eq("id", payload.enrollmentId);
      console.info("[enrollment-init-runner] Skipped — recipient is do_not_contact", { enrollmentId: payload.enrollmentId });
      return { action: "skipped", reason: "do_not_contact" };
    }

    if (person) {
      recipientEmail =
        person.type === "candidate"
          ? (person.personal_email || person.primary_email)
          : (person.work_email || person.primary_email);
      recipientLinkedin = person.linkedin_url || null;
      recipientPhone = person.phone || null;
    }

    const { data: ch } = await supabase
      .from("candidate_channels")
      .select("is_connected")
      .eq("candidate_id", recipientId)
      .eq("channel", "linkedin")
      .maybeSingle();
    recipientLinkedinConnected = (ch as any)?.is_connected === true;
  }

  function recipientHasRequired(channel: string): boolean {
    if (channel === "email") return !!recipientEmail;
    if (channel === "sms") return !!recipientPhone;
    if (channel.startsWith("linkedin")) return !!recipientLinkedin;
    return true; // manual_call, phone — no pre-flight
  }

  let prevSendTime = enrolledAt;
  for (const node of orderedNodes) {
    const actions = (node as any).sequence_actions || [];
    for (const action of actions) {
      // Skip actions that already have a non-cancelled log. Advance
      // the cursor to whichever timestamp anchors the next step:
      // sent_at if we shipped it, scheduled_at if it's still queued.
      const existing = existingByAction.get(action.id);
      if (existing) {
        if (existing.status === "sent" && existing.sent_at) {
          prevSendTime = new Date(existing.sent_at);
        } else if (existing.status === "scheduled" && existing.scheduled_at) {
          prevSendTime = new Date(existing.scheduled_at);
        }
        continue;
      }

      // Pre-skip if the recipient lacks the required field for this channel.
      if (!recipientHasRequired(action.channel)) {
        await supabase.from("sequence_step_logs").insert({
          enrollment_id: payload.enrollmentId,
          action_id: action.id,
          node_id: node.id,
          channel: action.channel,
          scheduled_at: null,
          status: "skipped",
          skip_reason:
            action.channel === "email" ? "no_email_on_record" :
            action.channel === "sms" ? "no_phone_on_record" :
            action.channel.startsWith("linkedin") ? "no_linkedin_url" :
            "missing_recipient_field",
        });
        preSkipped++;
        continue;
      }

      // Already connected on LinkedIn → skip the connection request.
      if (action.channel === "linkedin_connection" && recipientLinkedinConnected) {
        await supabase.from("sequence_step_logs").insert({
          enrollment_id: payload.enrollmentId,
          action_id: action.id,
          node_id: node.id,
          channel: action.channel,
          scheduled_at: null,
          status: "skipped",
          skip_reason: "already_connected",
        });
        preSkipped++;
        continue;
      }

      if (action.channel === "linkedin_message" && !recipientLinkedinConnected) {
        // Park as pending_connection — webhook handler / poll will
        // schedule once the invite is accepted.
        await supabase.from("sequence_step_logs").insert({
          enrollment_id: payload.enrollmentId,
          action_id: action.id,
          node_id: node.id,
          channel: action.channel,
          scheduled_at: null,
          status: "pending_connection",
        });
        pendingConnection++;
      } else {
        // Floor the cursor at NOW so resumed sequences don't schedule
        // overdue steps that would all fire at once on the next sweep.
        if (prevSendTime.getTime() < Date.now()) prevSendTime = new Date();

        const scheduledAt = await calculateSendTime(supabase, {
          startTime: prevSendTime,
          delayHours: Number(action.base_delay_hours) || 0,
          delayMinutes: action.delay_interval_minutes || 0,
          jiggleMinutes: action.jiggle_minutes || 0,
          channel: action.channel,
          sendWindowStart: sequence.send_window_start || "09:00",
          sendWindowEnd: sequence.send_window_end || "18:00",
          accountId: senderUserId,
          timezone: sequence.timezone || undefined,
          weekdaysOnly: sequence.weekdays_only === true,
        });

        await supabase.from("sequence_step_logs").insert({
          enrollment_id: payload.enrollmentId,
          action_id: action.id,
          node_id: node.id,
          channel: action.channel,
          scheduled_at: scheduledAt.toISOString(),
          status: "scheduled",
        });
        prevSendTime = scheduledAt;
        scheduled++;
      }
    }
  }

  // Set current_node_id to first node (for tracking)
  await supabase
    .from("sequence_enrollments")
    .update({ current_node_id: orderedNodes[0].id })
    .eq("id", payload.enrollmentId);

  console.info("[enrollment-init-runner] Enrollment initialized", {
    enrollmentId: payload.enrollmentId,
    scheduled,
    pendingConnection,
    preSkipped,
  });

  return { action: "initialized", scheduled, pendingConnection, preSkipped };
}
