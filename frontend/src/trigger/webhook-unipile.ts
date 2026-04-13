import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";
import { stopEnrollment } from "./sequence-scheduler";
import { calculatePostConnectionSendTime } from "./lib/send-time-calculator";

interface UnipileWebhookPayload {
  body: {
    event?: string;
    type?: string;
    data?: any;
    message?: any;
    conversation?: any;
    connection?: any;
  };
  receivedAt: string;
}

/**
 * Process Unipile webhook events (LinkedIn messages, connection updates).
 * Matches by provider_id in candidate_channels, logs activity,
 * runs sentiment analysis on replies via Claude Haiku.
 */
export const processUnipileEvent = task({
  id: "process-unipile-event",
  retry: { maxAttempts: 3 },
  run: async (payload: UnipileWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const event = payload.body;
    const eventType = event.event || event.type || "";

    logger.info("Processing Unipile event", { eventType });

    if (eventType.includes("message") || event.message) {
      return await processLinkedInMessage(supabase, event, payload.receivedAt);
    }

    if (eventType.includes("connection") || event.connection) {
      return await processConnectionUpdate(supabase, event, payload.receivedAt);
    }

    logger.info("Unhandled Unipile event type", { eventType });
    return { action: "skipped", reason: "unhandled_event_type" };
  },
});

async function processLinkedInMessage(supabase: any, event: any, receivedAt: string) {
  const messageData = event.data || event.message || event;
  const senderId = messageData.sender_id || messageData.provider_id || messageData.from?.provider_id;
  const messageBody = messageData.text || messageData.body || "";
  const externalMessageId = messageData.id || messageData.message_id;
  const externalConversationId = messageData.conversation_id || messageData.chat_id;

  // Detect LinkedIn variant (classic / Recruiter / Sales Navigator).
  // Primary: check event metadata from Unipile.
  // Fallback: look up the integration account's account_type by unipile_account_id,
  // since Unipile event metadata is often missing the provider type.
  const providerType = String(
    messageData.provider_type ??
    messageData.chat?.provider_type ??
    messageData.account_type ??
    messageData.folder ??
    event.account_type ??
    ""
  ).toLowerCase();
  let channel = providerType.includes("sales")
    ? "linkedin_sales_nav"
    : providerType.includes("recruiter")
      ? "linkedin_recruiter"
      : "linkedin";
  // If event metadata didn't classify it, check the integration account type
  if (channel === "linkedin") {
    const eventAccountId = messageData.account_id ?? event.account_id ?? messageData.chat?.account_id;
    if (eventAccountId) {
      const { data: ia } = await supabase
        .from("integration_accounts")
        .select("account_type")
        .eq("unipile_account_id", eventAccountId)
        .maybeSingle();
      if (ia?.account_type === "linkedin_recruiter") channel = "linkedin_recruiter";
      else if (ia?.account_type === "sales_navigator") channel = "linkedin_sales_nav";
    }
  }

  if (!senderId) {
    logger.info("No sender ID in message event");
    return { action: "skipped", reason: "no_sender_id" };
  }

  // Check for duplicate
  if (externalMessageId) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("external_message_id", externalMessageId)
      .limit(1);
    if (existing && existing.length > 0) {
      return { action: "skipped", reason: "duplicate" };
    }
  }

  // Match sender directly via candidates.unipile_id / contacts.unipile_id.
  // (Mirrors backfill-linkedin-messages.ts findEntity — the previous
  // candidate_channels/contact_channels tables don't exist in prod.)
  let entityId: string | null = null;
  let entityType: "candidate" | "contact" = "candidate";
  let entityColumn: "candidate_id" | "contact_id" = "candidate_id";

  const { data: candMatch } = await supabase
    .from("candidates")
    .select("id")
    .eq("unipile_id", senderId)
    .maybeSingle();

  if (candMatch) {
    entityId = candMatch.id;
  } else {
    const { data: contactMatch } = await supabase
      .from("contacts")
      .select("id")
      .eq("unipile_id", senderId)
      .maybeSingle();

    if (contactMatch) {
      entityId = contactMatch.id;
      entityType = "contact";
      entityColumn = "contact_id";
    }
  }

  // Handle unknown sender — create unlinked conversation and message
  if (!entityId) {
    logger.info("No matching entity for LinkedIn sender, creating unlinked conversation", { senderId });

    const senderName = messageData.sender_name || messageData.from?.name || messageData.from?.display_name || null;
    const senderAddress = messageData.sender_address || messageData.from?.identifier || messageData.from?.profile_url || senderId;

    const conversationId = externalConversationId || `li_unknown_${senderId}`;
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .maybeSingle();

    if (!existingConv) {
      await supabase.from("conversations").insert({
        id: conversationId,
        candidate_id: null,
        contact_id: null,
        channel,
        external_conversation_id: externalConversationId,
        last_message_at: receivedAt,
        is_read: false,
      } as any);
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      candidate_id: null,
      contact_id: null,
      channel,
      direction: "inbound",
      body: messageBody,
      sent_at: messageData.created_at || receivedAt,
      provider: "unipile",
      external_message_id: externalMessageId,
      external_conversation_id: externalConversationId,
      sender_name: senderName,
      sender_address: senderAddress,
      is_read: false,
    } as any);

    await supabase
      .from("conversations")
      .update({
        last_message_at: receivedAt,
        last_message_preview: messageBody.substring(0, 100),
        is_read: false,
      })
      .eq("id", conversationId);

    return { action: "logged_unlinked", senderId, senderName, type: "linkedin_message" };
  }

  // Determine or create conversation
  const conversationId = externalConversationId || `li_${entityId}`;
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (!existingConv) {
    await supabase.from("conversations").insert({
      id: conversationId,
      [entityColumn]: entityId,
      channel,
      external_conversation_id: externalConversationId,
      last_message_at: receivedAt,
    } as any);
  }

  // Insert inbound message
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    [entityColumn]: entityId,
    channel,
    direction: "inbound",
    body: messageBody,
    sent_at: messageData.created_at || receivedAt,
    provider: "unipile",
    external_message_id: externalMessageId,
    external_conversation_id: externalConversationId,
    is_read: false,
  } as any);

  // Update conversation
  await supabase
    .from("conversations")
    .update({
      last_message_at: receivedAt,
      last_message_preview: messageBody.substring(0, 100),
      is_read: false,
    })
    .eq("id", conversationId);

  // Update entity timestamps
  const table = entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: "linkedin",
    } as any)
    .eq("id", entityId);

  // Extract intelligence from inbound LinkedIn message
  if (messageBody.length > 10) {
    const intel = await extractMessageIntel(messageBody);
    if (intel) {
      const { data: enrollment } = await supabase
        .from("sequence_enrollments")
        .select("id")
        .eq(entityColumn, entityId)
        .eq("status", "active")
        .order("enrolled_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      await applyExtractedIntel(
        supabase, entityId, entityType as "candidate" | "contact",
        intel, "linkedin", enrollment?.id,
      );
    }
  }

  // Universal stop rule: any LinkedIn message reply stops active enrollments
  const { data: activeEnrollments } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq(entityColumn, entityId)
    .eq("status", "active");

  if (activeEnrollments && activeEnrollments.length > 0) {
    for (const enrollment of activeEnrollments) {
      await stopEnrollment(supabase, enrollment, "reply_received", messageBody);
    }
    logger.info("Stopped enrollments on LinkedIn reply", { entityId, count: activeEnrollments.length });
  }

  logger.info("LinkedIn message logged", { entityId, entityType });

  // Chain-trigger Joe Says refresh
  await generateJoeSays.trigger({
    entityId,
    entityType: entityType as "candidate" | "contact",
  });

  return { action: "logged", entityId, entityType, type: "linkedin_message" };
}

async function processConnectionUpdate(supabase: any, event: any, receivedAt: string) {
  const connectionData = event.data || event.connection || event;
  const providerId = connectionData.provider_id || connectionData.attendee_provider_id;
  const status = connectionData.status || connectionData.state || "";

  if (!providerId) {
    return { action: "skipped", reason: "no_provider_id" };
  }

  // Find candidate with this provider_id
  const { data: channelMatch } = await supabase
    .from("candidate_channels")
    .select("candidate_id")
    .or(`provider_id.eq.${providerId},unipile_id.eq.${providerId}`)
    .eq("channel", "linkedin")
    .limit(1)
    .maybeSingle();

  if (!channelMatch) {
    return { action: "no_match", providerId };
  }

  const candidateId = channelMatch.candidate_id;

  if (status === "ACCEPTED" || status === "accepted" || status === "connected") {
    // Update candidate_channels
    await supabase
      .from("candidate_channels")
      .update({ is_connected: true } as any)
      .eq("candidate_id", candidateId)
      .eq("channel", "linkedin");

    // V2: Find active enrollments for this candidate and advance via connection_accepted branch
    await advanceOnConnectionAccepted(supabase, "candidate_id", candidateId, receivedAt);

    // Also check contact_channels
    const { data: contactChannel } = await supabase
      .from("contact_channels")
      .select("contact_id")
      .or(`provider_id.eq.${providerId},unipile_id.eq.${providerId}`)
      .eq("channel", "linkedin")
      .maybeSingle();

    if (contactChannel?.contact_id) {
      await supabase
        .from("contact_channels")
        .update({ is_connected: true } as any)
        .eq("contact_id", contactChannel.contact_id)
        .eq("channel", "linkedin");

      await advanceOnConnectionAccepted(supabase, "contact_id", contactChannel.contact_id, receivedAt);
    }

    // Log connection_accepted as a special message type
    await supabase.from("messages").insert({
      conversation_id: `li_${candidateId}`,
      candidate_id: candidateId,
      channel: "linkedin",
      direction: "inbound",
      body: "Connection request accepted",
      message_type: "connection_accepted",
      sent_at: receivedAt,
      provider: "unipile",
    } as any);

    logger.info("Connection accepted", { candidateId });
    return { action: "connection_accepted", candidateId };
  }

  return { action: "connection_update", status, candidateId };
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 Sequence: Schedule pending_connection actions on connection accepted
// ─────────────────────────────────────────────────────────────────────────────

async function advanceOnConnectionAccepted(
  supabase: any,
  entityColumn: string,
  entityId: string,
  receivedAt: string,
): Promise<void> {
  // Find active enrollments for this entity
  const { data: enrollments } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq(entityColumn, entityId)
    .eq("status", "active");

  if (!enrollments || enrollments.length === 0) return;

  for (const enrollment of enrollments) {
    const sequence = enrollment.sequences;
    const senderUserId = sequence.sender_user_id || sequence.created_by;

    // Find all pending_connection step logs for this enrollment
    const { data: pendingLogs } = await supabase
      .from("sequence_step_logs")
      .select("*, sequence_actions!inner(*)")
      .eq("enrollment_id", enrollment.id)
      .eq("status", "pending_connection");

    if (!pendingLogs || pendingLogs.length === 0) continue;

    for (const log of pendingLogs) {
      const action = (log as any).sequence_actions;

      // Calculate: 4h minimum + additional delay, using business-hours model
      const scheduledAt = await calculatePostConnectionSendTime(
        supabase,
        new Date(receivedAt),
        Number(action.base_delay_hours) || 0,
        action.delay_interval_minutes || 0,
        action.jiggle_minutes || 0,
        sequence.send_window_start || "09:00",
        sequence.send_window_end || "18:00",
        senderUserId,
      );

      // Activate the step log
      await supabase
        .from("sequence_step_logs")
        .update({ scheduled_at: scheduledAt.toISOString(), status: "scheduled" })
        .eq("id", log.id);
    }

    logger.info("Connection accepted — scheduled pending linkedin messages", {
      enrollmentId: enrollment.id,
      count: pendingLogs.length,
    });
  }
}
