import { task, logger, wait } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn, resolveRecipient } from "./lib/send-channels";
import { resolveMergeTags, applyMergeTags, formatEmailBody, validateEmail } from "./lib/merge-tags";
import { checkRateLimit } from "./lib/rate-limiter";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Connection requests are exempt from send windows (fire 24/7)
const EXEMPT_FROM_WINDOW = new Set(["linkedin_connection"]);

// Channel-based send windows (UTC hours). EST = UTC-4.
// Values > 24 mean the window crosses midnight UTC (e.g. 27 = 03:00 next day).
const CHANNEL_SEND_WINDOWS: Record<string, { start: number; end: number }> = {
  email:              { start: 10, end: 22 },   // 6 AM – 6 PM EST
  sms:                { start: 11, end: 24 },   // 7 AM – 8 PM EST
  linkedin_message:   { start: 10, end: 25.5 }, // 6 AM – 9:30 PM EST
  linkedin_recruiter: { start: 10, end: 27 },   // 6 AM – 11 PM EST
  recruiter_inmail:   { start: 10, end: 27 },   // 6 AM – 11 PM EST
  sales_nav:          { start: 10, end: 27 },   // legacy fallback
  sales_nav_inmail:   { start: 10, end: 27 },   // legacy fallback
};

// OOO keyword patterns (checked before Claude for speed)
const OOO_PATTERNS = [
  /out of (?:the )?office/i,
  /auto[- ]?reply/i,
  /automatic reply/i,
  /away (?:from|until|till)/i,
  /returning on/i,
  /i(?:'m| am) (?:currently )?(?:out|away|on (?:leave|vacation|holiday|pto))/i,
  /back (?:on|in the office)/i,
  /limited access to email/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Main task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-enrollment step execution task.
 *
 * Pipeline:
 *  1. Validate enrollment & sequence are still active
 *  2. Reply guard → sentiment → OOO handling
 *  3. Resolve next step
 *  4. Idempotency check (skip if already sent this step)
 *  5. Send window check
 *  6. Per-channel, per-user rate limit check
 *  7. Pre-send validation (email format, connection status)
 *  8. Merge tags + format body
 *  9. Resolve reply threading (for is_reply steps)
 * 10. Jitter wait
 * 11. Send
 * 12. On success → create execution, log message, advance enrollment
 * 13. On failure → log failed execution, DO NOT advance (let retry re-attempt)
 */
export const processSequenceStep = task({
  id: "process-sequence-step",
  retry: { maxAttempts: 2 },
  run: async (payload: SequenceStepPayload) => {
    const supabase = getSupabaseAdmin();
    const now = new Date();

    const entityId = payload.candidateId || payload.contactId;
    const entityType: "candidate" | "contact" = payload.candidateId ? "candidate" : "contact";
    const entityColumn = payload.candidateId ? "candidate_id" : "contact_id";
    const nextStepOrder = (payload.currentStepOrder ?? 0) + 1;

    logger.info("Processing step", {
      enrollmentId: payload.enrollmentId,
      entityId,
      entityType,
      nextStepOrder,
    });

    // ── 1. VALIDATE ─────────────────────────────────────────────────
    // Re-check enrollment & sequence are still active (could have been
    // paused between sweep pickup and task execution)
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("id", payload.enrollmentId)
      .single();

    if (!enrollment || enrollment.status !== "active") {
      logger.info("Enrollment no longer active", { status: enrollment?.status });
      return { action: "skipped", reason: "enrollment_not_active" };
    }

    const { data: sequence } = await supabase
      .from("sequences")
      .select("status")
      .eq("id", payload.sequenceId)
      .single();

    if (!sequence || sequence.status !== "active") {
      logger.info("Sequence no longer active", { status: sequence?.status });
      return { action: "skipped", reason: "sequence_not_active" };
    }

    // ── 2. REPLY GUARD ──────────────────────────────────────────────
    if (payload.stopOnReply && entityId) {
      const result = await handleReplyGuard(
        supabase, payload, entityId, entityColumn, now,
      );
      if (result) return result;
    }

    // ── 3. RESOLVE STEP ─────────────────────────────────────────────
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
      // No more steps → mark enrollment completed
      await supabase
        .from("sequence_enrollments")
        .update({
          status: "completed",
          completed_at: now.toISOString(),
        } as any)
        .eq("id", payload.enrollmentId);
      logger.info("Enrollment completed — no more steps");
      return { action: "completed" };
    }

    const stepChannel = step.channel || step.step_type || payload.sequenceChannel || "email";

    if (!step.body?.trim()) {
      logger.warn("Step has empty body, skipping", { stepId: step.id });
      // Advance past this step
      await advanceEnrollment(supabase, payload.enrollmentId, step, now, stepChannel);
      return { action: "skipped", reason: "empty_body" };
    }

    // ── 4. IDEMPOTENCY CHECK ────────────────────────────────────────
    // Prevent duplicate sends if task retries after partial success
    const { data: existingExec } = await supabase
      .from("sequence_step_executions")
      .select("id")
      .eq("enrollment_id", payload.enrollmentId)
      .eq("sequence_step_id", step.id)
      .in("status", ["sent", "delivered"])
      .maybeSingle();

    if (existingExec) {
      logger.info("Step already executed, skipping duplicate", { execId: existingExec.id });
      return { action: "skipped", reason: "already_executed" };
    }

    // ── 5. SEND WINDOW CHECK ────────────────────────────────────────
    if (!EXEMPT_FROM_WINDOW.has(stepChannel)) {
      const windowResult = checkSendWindow(step, stepChannel, now);
      if (!windowResult.inWindow) {
        await supabase
          .from("sequence_enrollments")
          .update({ next_step_at: windowResult.nextWindowAt!.toISOString() } as any)
          .eq("id", payload.enrollmentId);
        logger.info("Outside send window — rescheduled", {
          nextWindow: windowResult.nextWindowAt!.toISOString(),
        });
        return { action: "rescheduled", reason: "outside_send_window" };
      }
    }

    // ── 6. RATE LIMIT CHECK ─────────────────────────────────────────
    const sendStart = step.send_window_start ?? (entityType === "contact" ? 10 : 10);
    const rateResult = await checkRateLimit(
      supabase, stepChannel, payload.enrolledBy, now, sendStart,
    );
    if (!rateResult.allowed) {
      await supabase
        .from("sequence_enrollments")
        .update({ next_step_at: rateResult.retryAt!.toISOString() } as any)
        .eq("id", payload.enrollmentId);
      logger.info("Rate limit hit — rescheduled", {
        reason: rateResult.reason,
        retryAt: rateResult.retryAt!.toISOString(),
      });
      return { action: "rescheduled", reason: rateResult.reason };
    }

    // ── 7. PRE-SEND VALIDATION ──────────────────────────────────────
    if (!entityId) {
      logger.error("No entity ID", { enrollmentId: payload.enrollmentId });
      return { action: "skipped", reason: "no_entity_id" };
    }

    // Resolve recipient address
    const { to, conversationId: cachedConvId } = await resolveRecipient(
      supabase, stepChannel, entityId, entityType,
      payload.enrolledBy, step.account_id || payload.accountId,
    );

    // Email format validation
    if (stepChannel === "email") {
      const emailCheck = validateEmail(to);
      if (!emailCheck.valid) {
        await stopEnrollment(supabase, payload.enrollmentId, `invalid_email: ${emailCheck.reason}`, now);
        logger.warn("Invalid email — enrollment stopped", { email: to, reason: emailCheck.reason });
        return { action: "stopped", reason: `invalid_email_${emailCheck.reason}` };
      }
    }

    // LinkedIn connection: if already connected, skip to next step immediately
    if (stepChannel === "linkedin_connection" && entityId) {
      const channelTable = entityType === "candidate" ? "candidate_channels" : "contact_channels";
      const { data: linkedInChannel } = await supabase
        .from(channelTable)
        .select("is_connected")
        .eq(entityType === "candidate" ? "candidate_id" : "contact_id", entityId)
        .eq("channel", "linkedin")
        .maybeSingle();

      if (linkedInChannel?.is_connected) {
        logger.info("Already connected — skipping connection request, advancing to next step", { entityId });
        await advanceEnrollment(supabase, payload.enrollmentId, step, now, stepChannel);
        return { action: "skipped", reason: "already_connected" };
      }
    }

    // ── 8. MERGE TAGS + FORMAT BODY ─────────────────────────────────
    const mergeVars = await resolveMergeTags(supabase, entityId, entityType);
    const rawBody = applyMergeTags(step.body, mergeVars);
    const rawSubject = applyMergeTags(step.subject, mergeVars);

    // Convert plaintext newlines to HTML for email
    const body = stepChannel === "email" ? formatEmailBody(rawBody) : rawBody;

    // ── 9. RESOLVE THREADING ────────────────────────────────────────
    let subject = rawSubject;
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (step.is_reply && stepChannel === "email") {
      // Find the previous step's execution to get the original message ID for threading
      const { data: prevExec } = await supabase
        .from("sequence_step_executions")
        .select("external_message_id, sequence_step_id")
        .eq("enrollment_id", payload.enrollmentId)
        .eq("status", "sent")
        .order("executed_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (prevExec?.external_message_id) {
        inReplyTo = prevExec.external_message_id;
        references = prevExec.external_message_id;
      }

      // Always get the first step's subject for "Re: ..." — look up by sequence + step_order 1
      const { data: firstStep } = await supabase
        .from("sequence_steps")
        .select("subject")
        .eq("sequence_id", payload.sequenceId)
        .eq("step_order", 1)
        .maybeSingle();

      const origSubject = applyMergeTags(firstStep?.subject, mergeVars);
      if (origSubject) {
        subject = origSubject.startsWith("Re: ") ? origSubject : `Re: ${origSubject}`;
      }

      // Fallback: never send with empty subject
      if (!subject) {
        subject = "Following up";
      }
    }

    // Final fallback — no email should ever go out with empty subject
    if (stepChannel === "email" && !subject) {
      subject = "Following up";
    }

    // ── 10. CHANNEL-SPECIFIC PACING ────────────────────────────────
    const pacingMs = getChannelPacing(stepChannel);
    if (pacingMs > 0) {
      const pacingMin = Math.round(pacingMs / 60000);
      logger.info("Pacing wait", { channel: stepChannel, minutes: pacingMin });
      await wait.for({ seconds: Math.round(pacingMs / 1000) });
    }

    // ── 11. SEND ────────────────────────────────────────────────────
    try {
      // Ensure conversation exists
      const conversationId = cachedConvId || `seq_${payload.enrollmentId}`;
      const { data: existingConv } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .maybeSingle();

      if (!existingConv) {
        await supabase.from("conversations").insert({
          id: conversationId,
          candidate_id: payload.candidateId || null,
          contact_id: payload.contactId || null,
          owner_id: payload.enrolledBy,
          channel: stepChannel,
          subject: subject || null,
          last_message_at: now.toISOString(),
        } as any);
      }

      let externalMessageId: string | null = null;
      let externalConversationId: string | null = null;
      let internetMessageId: string | undefined;

      switch (stepChannel) {
        case "email": {
          const result = await sendEmail(
            supabase, to, subject, body, payload.enrolledBy,
            inReplyTo ? { inReplyTo, references } : undefined,
            step.use_signature,
          );
          externalMessageId = result.messageId;
          internetMessageId = result.internetMessageId;
          break;
        }
        case "sms": {
          const result = await sendSms(supabase, to, body, payload.enrolledBy);
          externalMessageId = result.id;
          break;
        }
        default: {
          const result = await sendLinkedIn(
            supabase, to, body, payload.enrolledBy,
            step.account_id || payload.accountId, stepChannel,
          );
          externalMessageId = result.message_id;
          externalConversationId = result.conversation_id;
          break;
        }
      }

      // ── 12. ON SUCCESS ──────────────────────────────────────────
      const sendTime = new Date();

      // Create execution record (AFTER send, not before)
      await supabase.from("sequence_step_executions").insert({
        enrollment_id: payload.enrollmentId,
        sequence_step_id: step.id,
        status: "sent",
        executed_at: sendTime.toISOString(),
        external_message_id: internetMessageId || externalMessageId,
        external_conversation_id: externalConversationId || conversationId,
      } as any);

      // Log outbound message
      const provider = stepChannel === "email" ? "microsoft_graph"
        : stepChannel === "sms" ? "ringcentral" : "unipile";

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        candidate_id: payload.candidateId || null,
        contact_id: payload.contactId || null,
        channel: stepChannel,
        direction: "outbound",
        subject: subject || null,
        body,
        recipient_address: to,
        sent_at: sendTime.toISOString(),
        external_message_id: internetMessageId || externalMessageId,
        external_conversation_id: externalConversationId || conversationId,
        provider,
        owner_id: payload.enrolledBy,
      } as any);

      // Update conversation
      await supabase
        .from("conversations")
        .update({
          last_message_at: sendTime.toISOString(),
          last_message_preview: rawBody.substring(0, 100),
          is_read: true,
        })
        .eq("id", conversationId);

      // Advance enrollment (AFTER successful send)
      if (stepChannel === "linkedin_connection") {
        // Park enrollment — wait for connection acceptance webhook to advance
        await supabase
          .from("sequence_enrollments")
          .update({
            current_step_order: step.step_order,
            waiting_for_connection_acceptance: true,
            next_step_at: null, // null = parked, not paused
          } as any)
          .eq("id", payload.enrollmentId);
        logger.info("Connection sent — parked until acceptance", { enrollmentId: payload.enrollmentId });
      } else {
        await advanceEnrollment(supabase, payload.enrollmentId, step, sendTime, stepChannel);
      }

      // Pipeline automation: first step → advance send_outs
      if (payload.candidateId && nextStepOrder === 1) {
        const { data: updated } = await supabase
          .from("send_outs")
          .update({ stage: "reached_out", updated_at: sendTime.toISOString() } as any)
          .eq("candidate_id", payload.candidateId)
          .eq("stage", "new")
          .select("id");
        if (updated?.length) {
          logger.info("Pipeline auto-advanced to reached_out", {
            candidateId: payload.candidateId,
            sendOutIds: updated.map((s: any) => s.id),
          });
        }
      }

      logger.info("Message sent", {
        enrollmentId: payload.enrollmentId,
        channel: stepChannel,
        to,
        step: nextStepOrder,
      });

      return { action: "sent", channel: stepChannel, step: nextStepOrder };

    } catch (sendErr: any) {
      // ── 13. ON FAILURE ────────────────────────────────────────────
      // Log failed execution but DO NOT advance enrollment
      await supabase.from("sequence_step_executions").insert({
        enrollment_id: payload.enrollmentId,
        sequence_step_id: step.id,
        status: "failed",
        error_message: sendErr.message,
        executed_at: new Date().toISOString(),
      } as any);

      logger.error("Send failed", {
        enrollmentId: payload.enrollmentId,
        error: sendErr.message,
      });

      // Re-throw so Trigger.dev retries
      throw sendErr;
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reply guard: check for inbound messages since enrollment.
 * If found, analyze sentiment and handle OOO / do-not-contact / normal replies.
 * Returns an action object if the enrollment should stop, or null to continue.
 */
async function handleReplyGuard(
  supabase: any,
  payload: SequenceStepPayload,
  entityId: string,
  entityColumn: string,
  now: Date,
): Promise<any | null> {
  const { data: replies } = await supabase
    .from("messages")
    .select("id, body, subject")
    .eq(entityColumn, entityId)
    .eq("direction", "inbound")
    .gte("created_at", payload.enrolledAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (!replies || replies.length === 0) return null;

  const reply = replies[0];

  // Mark latest execution as replied
  const { data: latestExec } = await supabase
    .from("sequence_step_executions")
    .select("id")
    .eq("enrollment_id", payload.enrollmentId)
    .in("status", ["sent", "delivered", "opened"])
    .order("executed_at", { ascending: false })
    .limit(1);

  if (latestExec?.[0]) {
    await supabase
      .from("sequence_step_executions")
      .update({ status: "replied" } as any)
      .eq("id", latestExec[0].id);
  }

  // Analyze sentiment
  const replyText = (reply.body || reply.subject || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let sentiment = "unknown";
  let summary = "";
  let oooReturnDate: string | null = null;

  // Fast OOO pattern check (before Claude call)
  const isOooPattern = OOO_PATTERNS.some((p) => p.test(replyText));

  if (replyText.length > 5) {
    try {
      const apiKey = await getAnthropicKey();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

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
          system: `Analyze this recruiting email reply. Determine sentiment and if it's an out-of-office auto-reply. Return ONLY valid JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact|ooo",
  "summary": "one sentence summary",
  "ooo_return_date": "YYYY-MM-DD or null if not OOO or no return date"
}
Use "ooo" for auto-replies / out-of-office messages.
Use "do_not_contact" if they explicitly ask to be removed from all outreach.`,
          messages: [{ role: "user", content: replyText.slice(0, 2000) }],
          temperature: 0,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

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
      logger.warn("Sentiment analysis failed", { error: err.message });
      // If Claude fails but OOO pattern matched, treat as OOO
      if (isOooPattern) {
        sentiment = "ooo";
        summary = "Auto-detected as out-of-office (sentiment API unavailable)";
      }
    }
  }

  // Store sentiment on enrollment
  await supabase
    .from("sequence_enrollments")
    .update({
      reply_sentiment: sentiment,
      reply_sentiment_note: summary,
    } as any)
    .eq("id", payload.enrollmentId);

  // ── OOO with return date → reschedule ──────────────────────────
  if (sentiment === "ooo" && oooReturnDate) {
    const returnDate = new Date(oooReturnDate);
    returnDate.setDate(returnDate.getDate() + 1);
    // ~10 AM EST (14 UTC) + 0-45 min jitter
    returnDate.setUTCHours(14, Math.floor(Math.random() * 45), 0, 0);

    await supabase
      .from("sequence_enrollments")
      .update({ next_step_at: returnDate.toISOString() } as any)
      .eq("id", payload.enrollmentId);

    logger.info("OOO — rescheduled after return", {
      enrollmentId: payload.enrollmentId,
      returnDate: oooReturnDate,
      nextStepAt: returnDate.toISOString(),
    });
    return { action: "rescheduled", reason: "ooo_return_date", returnDate: oooReturnDate };
  }

  // ── do_not_contact → stop ALL enrollments for this entity ──────
  if (sentiment === "do_not_contact") {
    await supabase
      .from("sequence_enrollments")
      .update({
        status: "stopped",
        stopped_reason: "do_not_contact",
        completed_at: now.toISOString(),
      } as any)
      .eq(entityColumn, entityId)
      .eq("status", "active");

    logger.warn("DNC — stopped ALL enrollments", { entityId });
    return { action: "stopped", reason: "do_not_contact", sentiment };
  }

  // ── All other replies → stop ALL active enrollments for this entity ──
  const reason = sentiment === "ooo" ? "ooo_no_return_date" : "contact_replied";
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "stopped",
      stopped_reason: reason,
      completed_at: now.toISOString(),
    } as any)
    .eq(entityColumn, entityId)
    .eq("status", "active");

  logger.info("Reply detected — all enrollments stopped", {
    entityId,
    sentiment,
    summary,
  });
  return { action: "stopped", reason, sentiment };
}

/**
 * Check whether the current time is within the channel's send window.
 */
function checkSendWindow(
  step: any,
  stepChannel: string,
  now: Date,
): { inWindow: boolean; nextWindowAt?: Date } {
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentTime = currentHour + currentMinute / 60;

  const channelWindow = CHANNEL_SEND_WINDOWS[stepChannel] ?? { start: 10, end: 22 };
  const sendStart = step.send_window_start ?? channelWindow.start;
  const sendEnd = step.send_window_end ?? channelWindow.end;

  let inWindow: boolean;
  if (sendEnd > 24) {
    // Window crosses midnight UTC
    inWindow = currentTime >= sendStart || currentTime < (sendEnd - 24);
  } else {
    inWindow = currentTime >= sendStart && currentTime < sendEnd;
  }

  if (inWindow) return { inWindow: true };

  // Calculate next window start
  const nextWindow = new Date(now);
  if (currentTime >= (sendEnd > 24 ? sendEnd - 24 : sendEnd)) {
    // Past end → next window is tomorrow
    nextWindow.setUTCDate(nextWindow.getUTCDate() + 1);
  }
  nextWindow.setUTCHours(sendStart, Math.floor(Math.random() * 45), 0, 0);

  return { inWindow: false, nextWindowAt: nextWindow };
}

/**
 * Advance enrollment after a successful send.
 * Calculates next_step_at based on the step's delay + jitter,
 * clipped to the channel's send window.
 */
async function advanceEnrollment(
  supabase: any,
  enrollmentId: string,
  step: any,
  sendTime: Date,
  stepChannel?: string,
) {
  const delayMs =
    ((step.delay_days ?? 0) * 24 * 60 + (step.delay_hours ?? 0) * 60) * 60 * 1000;
  // Add 2-35 min jitter on top of the step delay
  const jitterMs = (2 + Math.floor(Math.random() * 33)) * 60 * 1000;
  const nextStepAt = new Date(sendTime.getTime() + delayMs + jitterMs);

  // Use the channel's send window to clip (fallback to email window)
  const channelWindow = CHANNEL_SEND_WINDOWS[stepChannel || "email"] ?? { start: 10, end: 22 };
  const sendStart = channelWindow.start;
  const sendEnd = channelWindow.end;
  const nextHour = nextStepAt.getUTCHours() + nextStepAt.getUTCMinutes() / 60;

  // Check if outside window (handle midnight crossing for windows > 24)
  const outsideWindow = sendEnd > 24
    ? (nextHour >= (sendEnd - 24) && nextHour < sendStart)
    : (nextHour < sendStart || nextHour >= sendEnd);

  if (outsideWindow) {
    nextStepAt.setUTCHours(sendStart, Math.floor(Math.random() * 45), 0, 0);
    // If we're past the end of the window, bump to next day
    if (nextHour >= (sendEnd > 24 ? sendEnd - 24 : sendEnd)) {
      nextStepAt.setUTCDate(nextStepAt.getUTCDate() + 1);
    }
  }

  await supabase
    .from("sequence_enrollments")
    .update({
      current_step_order: step.step_order,
      next_step_at: nextStepAt.toISOString(),
    } as any)
    .eq("id", enrollmentId);
}

/**
 * Per-channel pacing: how long to wait before sending.
 * InMails: 1 min. Connections: 6-11 min. Email: 1-8 min. SMS: 0 (batch via sweep).
 */
function getChannelPacing(channel: string): number {
  if (["linkedin_recruiter", "recruiter_inmail", "sales_nav", "sales_nav_inmail"].includes(channel)) {
    return 60 * 1000; // 1 minute for InMails
  }
  if (channel === "linkedin_connection") {
    return (5 + 1 + Math.floor(Math.random() * 6)) * 60 * 1000; // 6-11 min
  }
  if (channel === "email") {
    return (1 + Math.floor(Math.random() * 8)) * 60 * 1000; // 1-8 min
  }
  if (channel === "sms") {
    return 0; // batch pacing at sweep level
  }
  // linkedin_message or unknown
  return (1 + Math.floor(Math.random() * 8)) * 60 * 1000; // 1-8 min
}

/** Stop an enrollment with a reason. */
async function stopEnrollment(
  supabase: any,
  enrollmentId: string,
  reason: string,
  now: Date,
) {
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "stopped",
      stopped_reason: reason,
      completed_at: now.toISOString(),
    } as any)
    .eq("id", enrollmentId);
}
