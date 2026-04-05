import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./lib/send-channels";

interface SequenceStepPayload {
  enrollmentId: string;
  sequenceId: string;
  candidateId?: string;
  contactId?: string;
  currentStepOrder: number | null;
  accountId?: string;
  enrolledBy: string;
  enrolledAt?: string;
  stopOnReply: boolean;
  sequenceChannel: string;
}

/**
 * Per-enrollment step execution task.
 * Handles reply guard, send window, rate limiting, message sending,
 * and next-step scheduling.
 *
 * Ported from process-sequence-emails/index.ts (lines 76-509)
 */
export const processSequenceStep = task({
  id: "process-sequence-step",
  retry: {
    maxAttempts: 2,
  },
  run: async (payload: SequenceStepPayload) => {
    const supabase = getSupabaseAdmin();
    const now = new Date();
    const currentHour = now.getUTCHours();
    const nextStepOrder = (payload.currentStepOrder ?? 0) + 1;

    const entityId = payload.candidateId || payload.contactId;
    const entityType: "candidate" | "contact" = payload.candidateId
      ? "candidate"
      : "contact";
    const entityColumn = payload.candidateId
      ? "candidate_id"
      : "contact_id";

    logger.info("Processing step", {
      enrollmentId: payload.enrollmentId,
      entityId,
      entityType,
      nextStepOrder,
    });

    // ── 1. Reply guard (stop_on_reply) ──────────────────────────────
    if (payload.stopOnReply && entityId) {
      const { data: replies } = await supabase
        .from("messages")
        .select("id")
        .eq(entityColumn, entityId)
        .eq("direction", "inbound")
        .gte(
          "created_at",
          payload.enrolledAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        )
        .limit(1);

      if (replies && replies.length > 0) {
        // Mark the latest sent execution as 'replied'
        const { data: latestExec } = await supabase
          .from("sequence_step_executions")
          .select("id")
          .eq("enrollment_id", payload.enrollmentId)
          .in("status", ["sent", "delivered", "opened"])
          .order("executed_at", { ascending: false })
          .limit(1);

        if (latestExec && latestExec.length > 0) {
          await supabase
            .from("sequence_step_executions")
            .update({ status: "replied" } as any)
            .eq("id", latestExec[0].id);
        }

        await supabase
          .from("sequence_enrollments")
          .update({
            status: "stopped",
            stopped_reason: "candidate_replied",
            completed_at: now.toISOString(),
          } as any)
          .eq("id", payload.enrollmentId);

        // Note: Pipeline stage changes (pitch/rejected) are now handled by sentiment
        // analysis in the webhook handlers (webhook-microsoft, webhook-unipile, webhook-ringcentral)

        logger.info("Enrollment stopped — reply detected", { enrollmentId: payload.enrollmentId });
        return { action: "stopped", reason: "candidate_replied" };
      }
    }

    // ── 2. Get the next step ────────────────────────────────────────
    const { data: step, error: stepError } = await supabase
      .from("sequence_steps")
      .select("*")
      .eq("sequence_id", payload.sequenceId)
      .eq("step_order", nextStepOrder)
      .eq("is_active", true)
      .maybeSingle();

    if (stepError) {
      logger.error("Error fetching step", { error: stepError });
      throw stepError;
    }

    if (!step) {
      // No more steps — mark enrollment completed
      await supabase
        .from("sequence_enrollments")
        .update({
          status: "completed",
          completed_at: now.toISOString(),
        } as any)
        .eq("id", payload.enrollmentId);

      logger.info("Enrollment completed — no more steps", { enrollmentId: payload.enrollmentId });
      return { action: "completed" };
    }

    // ── 3. Check send window ────────────────────────────────────────
    const sendStart = step.send_window_start ?? 6;
    const sendEnd = step.send_window_end ?? 23;

    if (currentHour < sendStart || currentHour >= sendEnd) {
      const nextWindow = new Date(now);
      if (currentHour >= sendEnd) {
        nextWindow.setDate(nextWindow.getDate() + 1);
      }
      nextWindow.setHours(sendStart, 0, 0, 0);
      const jitterMinutes = Math.floor(Math.random() * 10);
      nextWindow.setMinutes(jitterMinutes);

      await supabase
        .from("sequence_enrollments")
        .update({ next_step_at: nextWindow.toISOString() } as any)
        .eq("id", payload.enrollmentId);

      logger.info("Outside send window — rescheduled", {
        enrollmentId: payload.enrollmentId,
        nextWindow: nextWindow.toISOString(),
      });
      return { action: "rescheduled", reason: "outside_send_window" };
    }

    // ── 4. Rate limiting ────────────────────────────────────────────
    const stepChannel = step.channel || step.step_type || payload.sequenceChannel || "";
    const isConnection = stepChannel === "linkedin_connection";
    const isInMail =
      stepChannel === "linkedin_recruiter" ||
      stepChannel === "sales_nav" ||
      stepChannel === "recruiter_inmail" ||
      stepChannel === "sales_nav_inmail";

    if (!isInMail) {
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      const { data: todayExecs } = await supabase
        .from("sequence_step_executions")
        .select("id, sequence_step_id")
        .gte("executed_at", todayStart.toISOString())
        .in("status", ["sent", "scheduled"]);

      let relevantCount = 0;
      if (isConnection && todayExecs) {
        const stepIds = todayExecs.map((e: any) => e.sequence_step_id);
        if (stepIds.length > 0) {
          const { data: steps } = await supabase
            .from("sequence_steps")
            .select("id, channel, step_type")
            .in("id", stepIds);
          relevantCount = (steps ?? []).filter(
            (s: any) => s.channel === "linkedin_connection" || s.step_type === "linkedin_connection",
          ).length;
        }
      } else {
        relevantCount = (todayExecs ?? []).length;
      }

      const dailyCap = isConnection ? 40 : 180;
      if (relevantCount >= dailyCap) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);

        await supabase
          .from("sequence_enrollments")
          .update({ next_step_at: tomorrow.toISOString() } as any)
          .eq("id", payload.enrollmentId);

        logger.info("Daily cap reached — rescheduled", {
          enrollmentId: payload.enrollmentId,
          cap: dailyCap,
          count: relevantCount,
        });
        return { action: "rescheduled", reason: "daily_cap_reached" };
      }
    }

    // ── 5. Jitter delay ─────────────────────────────────────────────
    const randomDelayMinutes = isInMail ? 0 : 2 + Math.floor(Math.random() * 8);
    const scheduledSendAt = new Date(now.getTime() + randomDelayMinutes * 60 * 1000);

    // ── 6. Create execution record ──────────────────────────────────
    const { error: execError } = await supabase.from("sequence_step_executions").insert({
      enrollment_id: payload.enrollmentId,
      sequence_step_id: step.id,
      status: "scheduled",
      executed_at: scheduledSendAt.toISOString(),
    } as any);

    if (execError) {
      logger.error("Error creating execution", { error: execError });
      throw execError;
    }

    // ── 7. Calculate next step timing ───────────────────────────────
    const nextDelayMs =
      ((step.delay_days ?? 0) * 24 * 60 + (step.delay_hours ?? 0) * 60) * 60 * 1000;
    const nextStepAt = new Date(scheduledSendAt.getTime() + nextDelayMs);

    const nextHour = nextStepAt.getHours();
    if (nextHour < sendStart || nextHour >= sendEnd) {
      if (nextHour >= sendEnd) {
        nextStepAt.setDate(nextStepAt.getDate() + 1);
      }
      nextStepAt.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);
    }

    await supabase
      .from("sequence_enrollments")
      .update({
        current_step_order: nextStepOrder,
        next_step_at: nextStepAt.toISOString(),
      } as any)
      .eq("id", payload.enrollmentId);

    // ── 8. Resolve recipient and send ───────────────────────────────
    if (!entityId) {
      logger.error("No entity ID for enrollment", { enrollmentId: payload.enrollmentId });
      return { action: "skipped", reason: "no_entity_id" };
    }

    try {
      const { to, conversationId: cachedConvId } = await resolveRecipient(
        supabase,
        stepChannel,
        entityId,
        entityType,
        payload.enrolledBy,
        step.account_id || payload.accountId,
      );

      // Ensure conversation exists
      const conversationId = cachedConvId || `seq_${payload.enrollmentId}`;
      const { data: existingConv } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .single();

      if (!existingConv) {
        await supabase.from("conversations").insert({
          id: conversationId,
          candidate_id: payload.candidateId || null,
          contact_id: payload.contactId || null,
          owner_id: payload.enrolledBy,
          last_message_at: now.toISOString(),
        } as any);
      }

      // Send via appropriate channel
      let externalMessageId: string | null = null;
      let externalConversationId: string | null = null;

      switch (stepChannel) {
        case "email": {
          const result = await sendEmail(supabase, to, step.subject, step.body, payload.enrolledBy);
          externalMessageId = result.messageId;
          break;
        }
        case "sms": {
          const result = await sendSms(supabase, to, step.body, payload.enrolledBy);
          externalMessageId = result.id;
          break;
        }
        default: {
          // All LinkedIn variants — route to enrolled_by user's Unipile account
          const result = await sendLinkedIn(
            supabase,
            to,
            step.body,
            payload.enrolledBy,
            step.account_id || payload.accountId,
            stepChannel,
          );
          externalMessageId = result.message_id;
          externalConversationId = result.conversation_id;
          break;
        }
      }

      // Update execution status
      await supabase
        .from("sequence_step_executions")
        .update({
          status: "sent",
          external_message_id: externalMessageId,
          external_conversation_id: externalConversationId,
          executed_at: now.toISOString(),
        } as any)
        .eq("enrollment_id", payload.enrollmentId)
        .eq("sequence_step_id", step.id)
        .eq("status", "scheduled");

      // Log message in database
      const provider =
        stepChannel === "email" ? "microsoft_graph" : stepChannel === "sms" ? "ringcentral" : "unipile";
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        candidate_id: payload.candidateId || null,
        contact_id: payload.contactId || null,
        channel: stepChannel,
        direction: "outbound",
        subject: step.subject || null,
        body: step.body,
        recipient_address: to,
        sent_at: now.toISOString(),
        external_message_id: externalMessageId,
        external_conversation_id: externalConversationId,
        provider,
        owner_id: payload.enrolledBy,
      } as any);

      // Update conversation
      await supabase
        .from("conversations")
        .update({
          last_message_at: now.toISOString(),
          last_message_preview: step.body.substring(0, 100),
          is_read: true,
        })
        .eq("id", conversationId);

      // ── Pipeline automation: auto-advance send_out stage ──────
      if (payload.candidateId) {
        // If this is the first step (step_order = 1), move any "new" send_outs to "reached_out"
        if (nextStepOrder === 1) {
          const { data: updated } = await supabase
            .from("send_outs")
            .update({ stage: "reached_out", updated_at: now.toISOString() } as any)
            .eq("candidate_id", payload.candidateId)
            .eq("stage", "new")
            .select("id");
          if (updated && updated.length > 0) {
            logger.info("Pipeline auto-advanced to reached_out", {
              candidateId: payload.candidateId,
              sendOutIds: updated.map((s: any) => s.id),
            });
          }
        }
      }

      logger.info("Message sent", {
        enrollmentId: payload.enrollmentId,
        channel: stepChannel,
        to,
      });

      return { action: "sent", channel: stepChannel };
    } catch (sendErr: any) {
      // Mark execution as failed
      await supabase
        .from("sequence_step_executions")
        .update({
          status: "failed",
          error_message: sendErr.message,
          executed_at: now.toISOString(),
        } as any)
        .eq("enrollment_id", payload.enrollmentId)
        .eq("sequence_step_id", step.id)
        .eq("status", "scheduled");

      logger.error("Send failed", {
        enrollmentId: payload.enrollmentId,
        error: sendErr.message,
      });

      throw sendErr; // Let Trigger.dev retry
    }
  },
});
