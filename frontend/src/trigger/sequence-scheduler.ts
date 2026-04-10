/**
 * Sequence v2 Scheduler — Trigger.dev tasks for the branching node engine.
 *
 * Two tasks:
 *   1. sequence-enrollment-init — called when enrollment created, schedules T=0 actions
 *   2. sequence-action-execute — fires at scheduled_at for each action, sends, advances
 *
 * Each enrolled person runs on an independent clock. T=0 is enrolled_at (EST).
 */
import { task, logger, schedules, wait } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./lib/send-channels";
import { resolveMergeTags, applyMergeTags, formatEmailBody, validateEmail } from "./lib/merge-tags";
import { calculateSendTime, calculatePostConnectionSendTime, incrementDailySend } from "./lib/send-time-calculator";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EnrollmentInitPayload {
  enrollmentId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

interface ActionExecutePayload {
  stepLogId: string;
  enrollmentId: string;
  actionId: string;
  nodeId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  enrolledBy: string;
  accountId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1: Initialize enrollment — schedule first node's actions
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceEnrollmentInit = task({
  id: "sequence-enrollment-init",
  retry: { maxAttempts: 3 },
  run: async (payload: EnrollmentInitPayload) => {
    const supabase = getSupabaseAdmin();

    // Fetch enrollment
    const { data: enrollment, error: enrollErr } = await supabase
      .from("sequence_enrollments")
      .select("*")
      .eq("id", payload.enrollmentId)
      .single();

    if (enrollErr || !enrollment) {
      logger.error("Enrollment not found", { enrollmentId: payload.enrollmentId });
      return { action: "error", reason: "enrollment_not_found" };
    }

    if (enrollment.status !== "active") {
      return { action: "skipped", reason: `enrollment_status_${enrollment.status}` };
    }

    // Fetch sequence
    const { data: sequence } = await supabase
      .from("sequences")
      .select("*")
      .eq("id", payload.sequenceId)
      .single();

    if (!sequence) {
      logger.error("Sequence not found", { sequenceId: payload.sequenceId });
      return { action: "error", reason: "sequence_not_found" };
    }

    // Find the first node (lowest node_order)
    const { data: firstNode } = await supabase
      .from("sequence_nodes")
      .select("*")
      .eq("sequence_id", payload.sequenceId)
      .order("node_order", { ascending: true })
      .limit(1)
      .single();

    if (!firstNode) {
      logger.error("No nodes in sequence", { sequenceId: payload.sequenceId });
      return { action: "error", reason: "no_nodes" };
    }

    // Update enrollment with current_node_id
    await supabase
      .from("sequence_enrollments")
      .update({ current_node_id: firstNode.id })
      .eq("id", payload.enrollmentId);

    // Schedule all actions on the first node
    const scheduled = await scheduleNodeActions(
      supabase,
      firstNode.id,
      payload.enrollmentId,
      enrollment.enrolled_at,
      sequence,
      payload.enrolledBy,
      payload.accountId,
    );

    logger.info("Enrollment initialized", {
      enrollmentId: payload.enrollmentId,
      firstNodeId: firstNode.id,
      actionsScheduled: scheduled,
    });

    return { action: "initialized", actionsScheduled: scheduled };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2: Execute a single scheduled action
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceActionExecute = task({
  id: "sequence-action-execute",
  retry: { maxAttempts: 2 },
  run: async (payload: ActionExecutePayload) => {
    const supabase = getSupabaseAdmin();

    // Re-validate enrollment is still active
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("id", payload.enrollmentId)
      .single();

    if (!enrollment || enrollment.status !== "active") {
      await markStepLog(supabase, payload.stepLogId, "cancelled");
      return { action: "cancelled", reason: "enrollment_not_active" };
    }

    // Check for reply (universal stop rule — any reply except connection acceptance)
    const hasReply = await hasRepliedSinceEnrollment(supabase, enrollment);
    if (hasReply) {
      await stopEnrollment(supabase, enrollment, "reply_received");
      await markStepLog(supabase, payload.stepLogId, "cancelled");
      return { action: "stopped", reason: "reply_received" };
    }

    // Fetch the action definition
    const { data: action } = await supabase
      .from("sequence_actions")
      .select("*")
      .eq("id", payload.actionId)
      .single();

    if (!action) {
      await markStepLog(supabase, payload.stepLogId, "failed");
      return { action: "error", reason: "action_not_found" };
    }

    const sequence = enrollment.sequences;
    const entityId = payload.candidateId || payload.contactId;
    const entityType = payload.candidateId ? "candidate" : "contact";

    if (!entityId) {
      await markStepLog(supabase, payload.stepLogId, "failed");
      return { action: "error", reason: "no_entity_id" };
    }

    // Use sender_user_id (selected in UI) or fall back to created_by, then to payload.enrolledBy
    const senderUserId = sequence.sender_user_id || sequence.created_by || payload.enrolledBy;

    // Manual call → just log it, don't send anything
    if (action.channel === "manual_call") {
      await markStepLog(supabase, payload.stepLogId, "sent", new Date());
      await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
      return { action: "manual_call_logged" };
    }

    // Pre-flight: check recipient has required contact info, skip gracefully if not
    const entityTable = entityType === "candidate" ? "candidates" : "contacts";
    const { data: entityRow } = await supabase
      .from(entityTable)
      .select("email, phone, linkedin_url")
      .eq("id", entityId)
      .maybeSingle();

    if (action.channel === "email" && !entityRow?.email) {
      await markStepSkipped(supabase, payload.stepLogId, "no_email_on_record");
      await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
      return { action: "skipped", reason: "no_email_on_record" };
    }
    if (action.channel === "sms" && !entityRow?.phone) {
      await markStepSkipped(supabase, payload.stepLogId, "no_phone_on_record");
      await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
      return { action: "skipped", reason: "no_phone_on_record" };
    }
    if (
      (action.channel === "linkedin_connection" ||
        action.channel === "linkedin_message" ||
        action.channel === "linkedin_inmail") &&
      !entityRow?.linkedin_url
    ) {
      await markStepSkipped(supabase, payload.stepLogId, "no_linkedin_url");
      await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
      return { action: "skipped", reason: "no_linkedin_url" };
    }

    // Resolve merge tags
    const mergeVars = await resolveMergeTags(supabase, entityId, entityType);
    mergeVars.sender_name = await getSenderName(supabase, senderUserId);
    if (sequence.job_id) {
      const { data: job } = await supabase.from("jobs").select("title").eq("id", sequence.job_id).maybeSingle();
      mergeVars.job_name = job?.title || "";
    }

    const messageBody = applyMergeTags(action.message_body, mergeVars);

    // Resolve recipient — catch "no X" errors and mark skipped
    let to: string;
    let conversationId: string | null;
    try {
      const resolved = await resolveRecipient(
        supabase,
        action.channel === "linkedin_inmail" ? "linkedin_message" : action.channel,
        entityId,
        entityType,
        senderUserId,
        payload.accountId,
      );
      to = resolved.to;
      conversationId = resolved.conversationId;
    } catch (err: any) {
      logger.warn("Recipient resolution failed, skipping", { channel: action.channel, error: err.message });
      await markStepSkipped(supabase, payload.stepLogId, `resolve_failed: ${err.message}`);
      await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
      return { action: "skipped", reason: err.message };
    }

    // Send via appropriate channel
    let sendResult: any;
    try {
      switch (action.channel) {
        case "email": {
          const emailValidation = validateEmail(to);
          if (!emailValidation.valid) {
            await markStepSkipped(supabase, payload.stepLogId, `invalid_email_${emailValidation.reason}`);
            await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);
            return { action: "skipped", reason: `invalid_email_${emailValidation.reason}` };
          }
          const htmlBody = formatEmailBody(messageBody);
          sendResult = await sendEmail(supabase, to, undefined, htmlBody, senderUserId, undefined, true);
          break;
        }
        case "sms":
          sendResult = await sendSms(supabase, to, messageBody, senderUserId);
          break;
        case "linkedin_connection":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_connection");
          break;
        case "linkedin_message":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "linkedin_message");
          break;
        case "linkedin_inmail":
          sendResult = await sendLinkedIn(supabase, to, messageBody, senderUserId, payload.accountId, "recruiter_inmail");
          break;
        default:
          await markStepLog(supabase, payload.stepLogId, "failed");
          return { action: "failed", reason: `unsupported_channel_${action.channel}` };
      }
    } catch (err: any) {
      logger.error("Send failed", { channel: action.channel, error: err.message });
      await markStepLog(supabase, payload.stepLogId, "failed");
      return { action: "failed", reason: err.message };
    }

    // Mark step log as sent
    const sentAt = new Date();
    await markStepLog(supabase, payload.stepLogId, "sent", sentAt);

    // Increment daily send counter
    const est = sentAt.toLocaleString("en-US", { timeZone: "America/New_York" });
    const estDate = new Date(est);
    const dateStr = `${estDate.getFullYear()}-${String(estDate.getMonth() + 1).padStart(2, "0")}-${String(estDate.getDate()).padStart(2, "0")}`;
    await incrementDailySend(supabase, payload.accountId || senderUserId, action.channel, dateStr);

    // Log the outbound message
    const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
    await supabase.from("messages").insert({
      [entityColumn]: entityId,
      conversation_id: conversationId || `seq_${payload.enrollmentId}`,
      channel: action.channel,
      direction: "outbound",
      body: messageBody,
      sent_at: sentAt.toISOString(),
      provider: action.channel.startsWith("linkedin") ? "unipile" : action.channel === "email" ? "microsoft_graph" : "ringcentral",
      external_message_id: sendResult?.messageId || sendResult?.message_id || sendResult?.id,
      owner_id: senderUserId,
    } as any);

    logger.info("Action sent", {
      channel: action.channel,
      enrollmentId: payload.enrollmentId,
      entityId,
    });

    // Advance to next node after all actions on this node are complete
    await advanceToNextNode(supabase, enrollment, payload.nodeId, sequence);

    return { action: "sent", channel: action.channel };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sweep task — picks up scheduled actions that are due
// ─────────────────────────────────────────────────────────────────────────────

export const sequenceSweep = schedules.task({
  id: "sequence-sweep-v2",
  cron: "*/3 10-17 * * *", // every 3 minutes, 10-17 UTC (5 AM - 12 PM EST)
  run: async () => {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Find step logs that are scheduled and due
    const { data: dueLogs, error } = await supabase
      .from("sequence_step_logs")
      .select(`
        id, enrollment_id, action_id, node_id, channel,
        sequence_enrollments!inner(
          id, sequence_id, candidate_id, contact_id, status,
          sequences!inner(id, created_by, sender_user_id)
        )
      `)
      .eq("status", "scheduled")
      .lte("scheduled_at", now)
      .eq("sequence_enrollments.status", "active")
      .limit(100);

    if (error) {
      logger.error("Sweep query failed", { error: error.message });
      return { action: "error" };
    }

    if (!dueLogs || dueLogs.length === 0) {
      return { action: "idle", due: 0 };
    }

    logger.info(`Sweep found ${dueLogs.length} due actions`);

    // Fan out to per-action execution tasks
    for (const log of dueLogs) {
      const enrollment = (log as any).sequence_enrollments;
      const sequence = enrollment?.sequences;

      await sequenceActionExecute.trigger({
        stepLogId: log.id,
        enrollmentId: enrollment.id,
        actionId: log.action_id,
        nodeId: log.node_id,
        sequenceId: enrollment.sequence_id,
        candidateId: enrollment.candidate_id || undefined,
        contactId: enrollment.contact_id || undefined,
        enrolledBy: sequence?.sender_user_id || sequence?.created_by,
        accountId: undefined,
      });
    }

    return { action: "dispatched", count: dueLogs.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Schedule all actions on a node
// ─────────────────────────────────────────────────────────────────────────────

async function scheduleNodeActions(
  supabase: any,
  nodeId: string,
  enrollmentId: string,
  enrolledAt: string,
  sequence: any,
  enrolledBy: string,
  accountId?: string,
): Promise<number> {
  const { data: actions } = await supabase
    .from("sequence_actions")
    .select("*")
    .eq("node_id", nodeId);

  if (!actions || actions.length === 0) return 0;

  let scheduled = 0;
  for (const action of actions) {
    const scheduledAt = await calculateSendTime(supabase, {
      enrolledAt,
      baseDelayHours: Number(action.base_delay_hours) || 0,
      delayIntervalMinutes: action.delay_interval_minutes || 0,
      jiggleMinutes: action.jiggle_minutes || 0,
      channel: action.channel,
      respectSendWindow: action.respect_send_window,
      sendWindowStart: sequence.send_window_start || "09:00",
      sendWindowEnd: sequence.send_window_end || "18:00",
      accountId: accountId || enrolledBy,
    });

    await supabase.from("sequence_step_logs").insert({
      enrollment_id: enrollmentId,
      action_id: action.id,
      node_id: nodeId,
      channel: action.channel,
      scheduled_at: scheduledAt.toISOString(),
      status: "scheduled",
    });

    scheduled++;
  }

  return scheduled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Advance enrollment to next node after current node completes
// ─────────────────────────────────────────────────────────────────────────────

async function advanceToNextNode(
  supabase: any,
  enrollment: any,
  currentNodeId: string,
  sequence: any,
): Promise<void> {
  // Check if all actions on this node are complete (sent/failed/skipped)
  const { data: pendingActions } = await supabase
    .from("sequence_step_logs")
    .select("id")
    .eq("enrollment_id", enrollment.id)
    .eq("node_id", currentNodeId)
    .eq("status", "scheduled");

  if (pendingActions && pendingActions.length > 0) {
    // Other actions still pending on this node — don't advance yet
    return;
  }

  // Find outgoing branches from this node
  const { data: branches } = await supabase
    .from("sequence_branches")
    .select("*")
    .eq("from_node_id", currentNodeId);

  if (!branches || branches.length === 0) {
    // No branches → sequence complete
    await supabase
      .from("sequence_enrollments")
      .update({
        status: "completed",
        stop_trigger: "completed",
        stopped_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id);
    return;
  }

  // Evaluate branches — for now, take the first matching condition
  // Default path is "no_response" (fallback after wait period)
  for (const branch of branches) {
    if (branch.condition === "end") {
      await supabase
        .from("sequence_enrollments")
        .update({
          status: "completed",
          stop_trigger: "completed",
          stopped_at: new Date().toISOString(),
        })
        .eq("id", enrollment.id);
      return;
    }

    // For no_response branches with after_days, schedule a delayed check
    if (branch.condition === "no_response" && branch.after_days) {
      const delayMs = branch.after_days * 24 * 60 * 60 * 1000;
      const checkAt = new Date(Date.now() + delayMs);

      // Schedule next node's actions with delay
      const { data: nextNode } = await supabase
        .from("sequence_nodes")
        .select("*")
        .eq("id", branch.to_node_id)
        .single();

      if (nextNode) {
        await supabase
          .from("sequence_enrollments")
          .update({ current_node_id: nextNode.id })
          .eq("id", enrollment.id);

        await scheduleNodeActions(
          supabase,
          nextNode.id,
          enrollment.id,
          checkAt.toISOString(), // Use the delayed time as the new base
          sequence,
          sequence.created_by,
        );
      }
      return;
    }

    // connection_accepted and connection_not_accepted are handled by webhooks
    if (branch.condition === "connection_accepted" || branch.condition === "connection_not_accepted") {
      // These are event-driven, not scheduled — webhook handler will advance
      continue;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Check if person has replied since enrollment
// ─────────────────────────────────────────────────────────────────────────────

async function hasRepliedSinceEnrollment(supabase: any, enrollment: any): Promise<boolean> {
  const entityColumn = enrollment.candidate_id ? "candidate_id" : "contact_id";
  const entityId = enrollment.candidate_id || enrollment.contact_id;

  const { data: replies } = await supabase
    .from("messages")
    .select("id")
    .eq(entityColumn, entityId)
    .eq("direction", "inbound")
    .neq("message_type", "connection_accepted")
    .gte("sent_at", enrollment.enrolled_at)
    .limit(1);

  return replies !== null && replies.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Stop enrollment and trigger Joe sentiment
// ─────────────────────────────────────────────────────────────────────────────

export async function stopEnrollment(
  supabase: any,
  enrollment: any,
  trigger: string,
  replyText?: string,
): Promise<void> {
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "stopped",
      stop_trigger: trigger,
      stop_reason: trigger,
      stopped_at: new Date().toISOString(),
    })
    .eq("id", enrollment.id);

  // Cancel all pending sends
  await supabase
    .from("sequence_step_logs")
    .update({ status: "cancelled" })
    .eq("enrollment_id", enrollment.id)
    .eq("status", "scheduled");

  logger.info("Enrollment stopped", { enrollmentId: enrollment.id, trigger });

  // Trigger Joe sentiment analysis if there's reply text
  if (replyText && trigger === "reply_received") {
    await triggerSentimentAnalysis(supabase, enrollment, replyText);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Trigger Joe sentiment analysis
// ─────────────────────────────────────────────────────────────────────────────

async function triggerSentimentAnalysis(
  supabase: any,
  enrollment: any,
  replyText: string,
): Promise<void> {
  try {
    const { data: sequence } = await supabase
      .from("sequences")
      .select("objective, audience_type, job_id, jobs(title)")
      .eq("id", enrollment.sequence_id)
      .single();

    const jobTitle = sequence?.jobs?.title || "";

    // Call ask-joe edge function for sentiment
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/ask-joe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "sentiment_analysis",
        reply_text: replyText,
        audience_type: sequence?.audience_type || "candidates",
        job_title: jobTitle,
        sequence_objective: sequence?.objective || "",
      }),
    });

    if (response.ok) {
      const result = await response.json();

      // Update the most recent step log with sentiment
      await supabase
        .from("sequence_step_logs")
        .update({
          reply_received_at: new Date().toISOString(),
          reply_text: replyText,
          sentiment: result.sentiment,
          sentiment_reason: result.reason,
        })
        .eq("enrollment_id", enrollment.id)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1);

      // Update entity record with sentiment
      const entityTable = enrollment.candidate_id ? "candidates" : "contacts";
      const entityId = enrollment.candidate_id || enrollment.contact_id;
      await supabase
        .from(entityTable)
        .update({
          last_sequence_sentiment: result.sentiment,
          last_sequence_sentiment_note: result.reason,
        } as any)
        .eq("id", entityId);

      // Update pipeline status if candidates + job
      if (enrollment.candidate_id && sequence?.job_id && result.pipeline_status) {
        await supabase
          .from("candidate_jobs")
          .update({ stage: result.pipeline_status } as any)
          .eq("candidate_id", enrollment.candidate_id)
          .eq("job_id", sequence.job_id);
      }

      logger.info("Sentiment analysis complete", { sentiment: result.sentiment, enrollmentId: enrollment.id });
    }
  } catch (err: any) {
    logger.error("Sentiment analysis failed", { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get sender name for merge tags
// ─────────────────────────────────────────────────────────────────────────────

async function getSenderName(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.full_name) return profile.full_name;
  if (profile?.first_name) return `${profile.first_name} ${profile.last_name || ""}`.trim();
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Update step log status
// ─────────────────────────────────────────────────────────────────────────────

async function markStepLog(
  supabase: any,
  stepLogId: string,
  status: string,
  sentAt?: Date,
): Promise<void> {
  const update: any = { status };
  if (sentAt) update.sent_at = sentAt.toISOString();
  await supabase.from("sequence_step_logs").update(update).eq("id", stepLogId);
}

async function markStepSkipped(
  supabase: any,
  stepLogId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("sequence_step_logs")
    .update({ status: "skipped", skip_reason: reason } as any)
    .eq("id", stepLogId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported for webhook handlers to use
// ─────────────────────────────────────────────────────────────────────────────

export { scheduleNodeActions };
