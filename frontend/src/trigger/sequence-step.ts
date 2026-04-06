import { task, logger, tasks } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
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

        // Fetch the reply body for sentiment analysis
        const { data: replyMsg } = await supabase
          .from("messages")
          .select("body, subject")
          .eq(entityColumn, entityId)
          .eq("direction", "inbound")
          .gte("created_at", payload.enrolledAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const replyText = (replyMsg?.body || replyMsg?.subject || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

        // Analyze sentiment + OOO detection via Claude
        let sentiment = "unknown";
        let summary = "";
        let oooReturnDate: string | null = null;

        if (replyText.length > 5) {
          try {
            const apiKey = await getAnthropicKey();
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 250,
                system: `Analyze this recruiting email reply. Determine sentiment and if it's an out-of-office (OOO) auto-reply with a return date. Return ONLY valid JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact|ooo",
  "summary": "one sentence summary",
  "ooo_return_date": "YYYY-MM-DD or null if not OOO or no return date mentioned"
}
Use "ooo" sentiment ONLY for auto-replies / out-of-office messages.`,
                messages: [{ role: "user", content: replyText.slice(0, 2000) }],
                temperature: 0,
              }),
            });

            if (resp.ok) {
              const data = await resp.json();
              const text = data.content?.[0]?.text || "";
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const analysis = JSON.parse(jsonMatch[0]);
                sentiment = analysis.sentiment || "unknown";
                summary = analysis.summary || "";
                oooReturnDate = analysis.ooo_return_date || null;
              }
            }
          } catch (err: any) {
            logger.warn("Sentiment analysis failed (non-fatal)", { error: err.message });
          }
        }

        // Update enrollment with sentiment
        await supabase
          .from("sequence_enrollments")
          .update({
            reply_sentiment: sentiment,
            reply_sentiment_note: summary,
          } as any)
          .eq("id", payload.enrollmentId);

        // OOO with return date → pause and reschedule for 1 day after return
        if (sentiment === "ooo" && oooReturnDate) {
          const returnDate = new Date(oooReturnDate);
          returnDate.setDate(returnDate.getDate() + 1);
          returnDate.setHours(14, Math.floor(Math.random() * 60), 0, 0); // ~10 AM ET next day

          await supabase
            .from("sequence_enrollments")
            .update({
              next_step_at: returnDate.toISOString(),
            } as any)
            .eq("id", payload.enrollmentId);

          logger.info("OOO detected — rescheduled after return", {
            enrollmentId: payload.enrollmentId,
            returnDate: oooReturnDate,
            nextStepAt: returnDate.toISOString(),
          });
          return { action: "rescheduled", reason: "ooo_return_date", returnDate: oooReturnDate };
        }

        // All other replies → stop the enrollment
        await supabase
          .from("sequence_enrollments")
          .update({
            status: "stopped",
            stopped_reason: sentiment === "ooo" ? "ooo_no_return_date" : "contact_replied",
            completed_at: now.toISOString(),
          } as any)
          .eq("id", payload.enrollmentId);

        logger.info("Enrollment stopped — reply detected", {
          enrollmentId: payload.enrollmentId,
          sentiment,
          summary,
        });
        return { action: "stopped", reason: "contact_replied", sentiment };
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
    // Contacts: 6:30 AM – 6 PM EST (10:30 – 22:00 UTC)
    // Candidates: 6:30 AM – 9:30 PM EST (10:30 – 01:30 UTC next day)
    const isContact = entityType === "contact";
    const defaultStart = 10; // 6 AM EST in UTC (rounded down — jitter covers the :30)
    const defaultEnd = isContact ? 22 : 25; // 6 PM EST or 9:30 PM EST in UTC (25 = 1 AM next day)
    const sendStart = step.send_window_start ?? defaultStart;
    const sendEnd = step.send_window_end ?? defaultEnd;

    // Normalize current hour for windows that cross midnight (candidate window)
    const effectiveHour = currentHour < sendStart && sendEnd > 24 ? currentHour + 24 : currentHour;
    const outsideWindow = effectiveHour < sendStart || effectiveHour >= sendEnd;

    if (outsideWindow) {
      const nextWindow = new Date(now);
      if (effectiveHour >= sendEnd || currentHour >= (sendEnd % 24)) {
        nextWindow.setDate(nextWindow.getDate() + 1);
      }
      nextWindow.setHours(sendStart, 0, 0, 0);
      // 0-45 min random jitter for more human-like start times
      const jitterMinutes = Math.floor(Math.random() * 45);

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

    // ── 4. Rate limiting (per-channel daily caps) ─────────────────
    const stepChannel = step.channel || step.step_type || payload.sequenceChannel || "";
    const isConnection = stepChannel === "linkedin_connection";
    const isLinkedInMsg =
      stepChannel === "linkedin_message" || stepChannel === "classic_message";
    const isInMail =
      stepChannel === "linkedin_recruiter" ||
      stepChannel === "sales_nav" ||
      stepChannel === "recruiter_inmail" ||
      stepChannel === "sales_nav_inmail";
    const isSms = stepChannel === "sms";
    const isEmail = stepChannel === "email";

    // Per-channel daily caps
    // LinkedIn connections: 40/day (LinkedIn enforced)
    // LinkedIn messages: 50/day
    // InMails: no cap (LinkedIn credits-based, skip rate limiting)
    // SMS: 50/day
    // Email: 150/day
    const channelCaps: Record<string, number> = {
      linkedin_connection: 40,
      linkedin_message: 50,
      sms: 50,
      email: 150,
    };

    const capCategory = isConnection ? "linkedin_connection"
      : isLinkedInMsg ? "linkedin_message"
      : isSms ? "sms"
      : isEmail ? "email"
      : null;

    if (capCategory && !isInMail) {
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      const { data: todayExecs } = await supabase
        .from("sequence_step_executions")
        .select("id, sequence_step_id")
        .gte("executed_at", todayStart.toISOString())
        .in("status", ["sent", "scheduled"]);

      // Count only executions for the same channel category
      let relevantCount = 0;
      if (todayExecs && todayExecs.length > 0) {
        const stepIds = todayExecs.map((e: any) => e.sequence_step_id);
        const { data: matchedSteps } = await supabase
          .from("sequence_steps")
          .select("id, channel, step_type")
          .in("id", stepIds);

        if (matchedSteps) {
          relevantCount = matchedSteps.filter((s: any) => {
            const ch = s.channel || s.step_type || "";
            if (capCategory === "linkedin_connection")
              return ch === "linkedin_connection";
            if (capCategory === "linkedin_message")
              return ch === "linkedin_message" || ch === "classic_message";
            if (capCategory === "sms")
              return ch === "sms";
            // email — everything that's not linkedin/sms
            return ch === "email";
          }).length;
        }
      }

      const dailyCap = channelCaps[capCategory] ?? 150;
      if (relevantCount >= dailyCap) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(sendStart, Math.floor(Math.random() * 45), 0, 0);

        await supabase
          .from("sequence_enrollments")
          .update({ next_step_at: tomorrow.toISOString() } as any)
          .eq("id", payload.enrollmentId);

        logger.info("Daily cap reached — rescheduled", {
          enrollmentId: payload.enrollmentId,
          channel: capCategory,
          cap: dailyCap,
          count: relevantCount,
        });
        return { action: "rescheduled", reason: "daily_cap_reached" };
      }
    }

    // ── 4b. Warmup: engage with candidate's LinkedIn posts before first outreach
    if (isConnection && nextStepOrder === 1 && payload.candidateId) {
      try {
        await tasks.trigger("warmup-candidate", {
          candidate_id: payload.candidateId,
          user_id: payload.enrolledBy,
          account_id: step.account_id || payload.accountId,
          max_engagements: 2,
        });
        logger.info("Triggered LinkedIn warmup before connection request", {
          candidateId: payload.candidateId,
        });
      } catch (err: any) {
        // Non-fatal — don't block the sequence if warmup fails
        logger.warn("Warmup trigger failed (non-fatal)", { error: err.message });
      }
    }

    // ── 5. Jitter delay — randomize send time to look human ────────
    // 1-15 minute random delay (InMails skip jitter)
    const randomDelayMinutes = isInMail ? 0 : 1 + Math.floor(Math.random() * 15);
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
      nextStepAt.setHours(sendStart, Math.floor(Math.random() * 45), 0, 0);
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
      // ── 8a. Merge-tag substitution ──────────────────────────────
      const entityTable = entityType === "candidate" ? "candidates" : "contacts";
      const { data: entity } = await supabase
        .from(entityTable)
        .select("first_name, last_name, full_name, email")
        .eq("id", entityId)
        .single();

      const mergeVars: Record<string, string> = {
        first_name: entity?.first_name || "",
        last_name: entity?.last_name || "",
        full_name: entity?.full_name || `${entity?.first_name ?? ""} ${entity?.last_name ?? ""}`.trim(),
        email: entity?.email || "",
      };

      const applyMergeTags = (text: string | null): string => {
        if (!text) return "";
        return text.replace(/\{\{(\w+)\}\}/g, (_, key) => mergeVars[key] ?? "");
      };

      const mergedBody = applyMergeTags(step.body);
      const mergedSubject = applyMergeTags(step.subject);

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
          const result = await sendEmail(supabase, to, mergedSubject, mergedBody, payload.enrolledBy);
          externalMessageId = result.messageId;
          break;
        }
        case "sms": {
          const result = await sendSms(supabase, to, mergedBody, payload.enrolledBy);
          externalMessageId = result.id;
          break;
        }
        default: {
          // All LinkedIn variants — route to enrolled_by user's Unipile account
          const result = await sendLinkedIn(
            supabase,
            to,
            mergedBody,
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
        subject: mergedSubject || null,
        body: mergedBody,
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
          last_message_preview: mergedBody.substring(0, 100),
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
