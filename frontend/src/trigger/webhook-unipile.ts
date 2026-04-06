import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";

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

  // Match sender to candidate via candidate_channels
  const { data: channelMatch } = await supabase
    .from("candidate_channels")
    .select("candidate_id")
    .or(`provider_id.eq.${senderId},unipile_id.eq.${senderId}`)
    .eq("channel", "linkedin")
    .limit(1)
    .maybeSingle();

  let entityId = channelMatch?.candidate_id;
  let entityType = "candidate";
  let entityColumn = "candidate_id";

  // Try contact_channels if no candidate match
  if (!entityId) {
    const { data: contactMatch } = await supabase
      .from("contact_channels")
      .select("contact_id")
      .or(`provider_id.eq.${senderId},unipile_id.eq.${senderId}`)
      .eq("channel", "linkedin")
      .limit(1)
      .maybeSingle();

    if (contactMatch) {
      entityId = contactMatch.contact_id;
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
        channel: "linkedin",
        external_conversation_id: externalConversationId,
        last_message_at: receivedAt,
        is_read: false,
      } as any);
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      candidate_id: null,
      contact_id: null,
      channel: "linkedin",
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
      channel: "linkedin",
      external_conversation_id: externalConversationId,
      last_message_at: receivedAt,
    } as any);
  }

  // Insert inbound message
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    [entityColumn]: entityId,
    channel: "linkedin",
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
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      await applyExtractedIntel(
        supabase, entityId, entityType as "candidate" | "contact",
        intel, "linkedin", enrollment?.id,
      );
    }
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

    // Advance any enrollments waiting for connection acceptance
    const { data: waitingEnrollments } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq("candidate_id", candidateId)
      .eq("status", "active")
      .eq("waiting_for_connection_acceptance", true);

    if (waitingEnrollments && waitingEnrollments.length > 0) {
      for (const enrollment of waitingEnrollments) {
        await supabase
          .from("sequence_enrollments")
          .update({
            waiting_for_connection_acceptance: false,
            linkedin_connection_status: "accepted",
            linkedin_connection_accepted_at: receivedAt,
            // Set next_step_at to now + 4 hours (per architecture rules)
            next_step_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          } as any)
          .eq("id", enrollment.id);
      }

      logger.info("Advanced waiting enrollments", {
        candidateId,
        count: waitingEnrollments.length,
      });
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

// Old analyzeSentiment() replaced by shared intel-extraction.ts module
