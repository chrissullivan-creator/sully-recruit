import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

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

  if (!entityId) {
    logger.info("No matching entity for LinkedIn sender", { senderId });
    return { action: "no_match", senderId };
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

  // Run sentiment analysis on the reply
  await analyzeSentiment(supabase, entityId, entityColumn, messageBody, receivedAt);

  logger.info("LinkedIn message logged", { entityId, entityType });
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

/**
 * Run sentiment analysis on inbound reply using Claude Haiku.
 * Stores result in reply_sentiment table.
 */
async function analyzeSentiment(
  supabase: any,
  entityId: string,
  entityColumn: string,
  messageBody: string,
  receivedAt: string,
) {
  try {
    const apiKey = getAnthropicKey();

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `Analyze the sentiment of this recruiting reply. Return ONLY valid JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact",
  "summary": "one sentence summary"
}`,
        messages: [{ role: "user", content: messageBody }],
        temperature: 0,
      }),
    });

    if (!resp.ok) return;

    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);

    // Find active enrollment for this entity
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq(entityColumn, entityId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    await supabase.from("reply_sentiment").insert({
      [entityColumn]: entityId,
      enrollment_id: enrollment?.id || null,
      channel: "linkedin",
      sentiment: analysis.sentiment,
      summary: analysis.summary,
      raw_message: messageBody,
      analyzed_at: receivedAt,
    } as any);

    // Update enrollment sentiment if exists
    if (enrollment) {
      await supabase
        .from("sequence_enrollments")
        .update({
          reply_sentiment: analysis.sentiment,
          reply_sentiment_note: analysis.summary,
          last_sequence_sentiment: analysis.sentiment,
        } as any)
        .eq("id", enrollment.id);
    }

    // Update candidate sentiment
    const table = entityColumn === "candidate_id" ? "candidates" : "contacts";
    await supabase
      .from(table)
      .update({
        last_sequence_sentiment: analysis.sentiment,
        last_sequence_sentiment_note: analysis.summary,
      } as any)
      .eq("id", entityId);

    logger.info("Sentiment analyzed", { entityId, sentiment: analysis.sentiment });
  } catch (err) {
    logger.error("Sentiment analysis error", { error: err });
    // Non-critical — don't throw
  }
}
