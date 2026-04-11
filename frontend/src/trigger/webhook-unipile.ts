import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getAppSetting, getUnipileBaseUrl } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";
import { stopEnrollment, scheduleNodeActions } from "./sequence-scheduler";
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

const MESSAGE_ATTACHMENTS_BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB — skip anything larger

type UploadedAttachment = {
  name: string;
  storage_path: string;
  mime_type: string | null;
  size: number | null;
};

/**
 * Download inbound attachments for a LinkedIn message from Unipile, upload
 * each to Supabase Storage, and return metadata rows for messages.attachments.
 *
 * Best-effort: any per-attachment failure is logged and skipped — we never
 * fail the entire message log because one file couldn't be retrieved.
 *
 * Unipile exposes attachments at:
 *   GET /messages/{message_id}/attachments/{attachment_id}?account_id=...
 * which may return either the raw file bytes OR a JSON wrapper with
 * base64 content, depending on account type. We handle both.
 */
async function fetchAndUploadUnipileAttachments(
  supabase: any,
  baseUrl: string,
  apiKey: string,
  unipileAccountId: string | null,
  messageId: string | null,
  rawAttachments: any[],
  conversationId: string,
): Promise<UploadedAttachment[]> {
  if (!messageId || !Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return [];
  }

  const results: UploadedAttachment[] = [];
  const uniHeaders: Record<string, string> = {
    "X-API-KEY": apiKey,
    Accept: "application/octet-stream, application/json",
  };

  for (const att of rawAttachments) {
    const attachmentId = att?.id ?? att?.attachment_id ?? att?.file_id;
    const rawName = att?.file_name ?? att?.name ?? att?.filename ?? `attachment_${attachmentId ?? Date.now()}`;
    const declaredMime = att?.mime_type ?? att?.mimetype ?? att?.content_type ?? null;
    const declaredSize: number | null = typeof att?.file_size === "number"
      ? att.file_size
      : typeof att?.size === "number"
        ? att.size
        : null;

    if (!attachmentId) {
      logger.warn("Unipile attachment missing id — skipping", { name: rawName });
      continue;
    }
    if (declaredSize !== null && declaredSize > MAX_ATTACHMENT_BYTES) {
      logger.warn("Skipping oversized inbound attachment", { name: rawName, size: declaredSize });
      continue;
    }

    try {
      const url =
        `${baseUrl}/messages/${encodeURIComponent(messageId)}` +
        `/attachments/${encodeURIComponent(attachmentId)}` +
        (unipileAccountId ? `?account_id=${encodeURIComponent(unipileAccountId)}` : "");

      const resp = await fetch(url, { headers: uniHeaders });
      if (!resp.ok) {
        logger.warn("Unipile attachment fetch failed", {
          status: resp.status,
          attachmentId,
          messageId,
        });
        continue;
      }

      // Handle both response shapes: raw binary or JSON { data_base64, ... }
      const contentType = resp.headers.get("content-type") || "";
      let buffer: Buffer;
      let resolvedMime: string | null = declaredMime;

      if (contentType.includes("application/json")) {
        const json: any = await resp.json();
        const b64: string = json.data_base64 ?? json.data ?? json.content ?? "";
        if (!b64) {
          logger.warn("Unipile JSON attachment had no base64 payload", { attachmentId });
          continue;
        }
        buffer = Buffer.from(b64, "base64");
        resolvedMime = json.content_type ?? json.mime_type ?? declaredMime;
      } else {
        const arrayBuf = await resp.arrayBuffer();
        buffer = Buffer.from(arrayBuf);
        resolvedMime = contentType || declaredMime;
      }

      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        logger.warn("Skipping oversized inbound attachment (post-download)", {
          name: rawName,
          bytes: buffer.byteLength,
        });
        continue;
      }

      // Build a deterministic, safe storage path — mirrors webhook-microsoft.ts
      const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const safeMsgId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const storagePath = `inbound/${conversationId}/${safeMsgId}/${attachmentId}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(MESSAGE_ATTACHMENTS_BUCKET)
        .upload(storagePath, buffer, {
          contentType: resolvedMime || "application/octet-stream",
          upsert: true,
        });

      if (uploadError) {
        logger.warn("Failed to upload inbound Unipile attachment", {
          name: rawName,
          error: uploadError.message,
        });
        continue;
      }

      results.push({
        name: String(rawName),
        storage_path: storagePath,
        mime_type: resolvedMime,
        size: declaredSize ?? buffer.byteLength,
      });
    } catch (err: any) {
      logger.warn("Error fetching Unipile attachment", {
        attachmentId,
        messageId,
        error: err?.message,
      });
    }
  }

  if (results.length > 0) {
    logger.info("Inbound Unipile attachments uploaded", {
      conversationId,
      messageId,
      count: results.length,
    });
  }
  return results;
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

  // Detect LinkedIn variant (classic / Recruiter / Sales Navigator) from the
  // event. Unipile surfaces this under several keys depending on event shape,
  // so check the common ones. Mirrors the backfill's classification logic in
  // backfill-linkedin-messages.ts.
  const providerType = String(
    messageData.provider_type ??
    messageData.chat?.provider_type ??
    messageData.account_type ??
    messageData.folder ??
    event.account_type ??
    ""
  ).toLowerCase();
  const channel = providerType.includes("sales")
    ? "linkedin_sales_nav"
    : providerType.includes("recruiter")
      ? "linkedin_recruiter"
      : "linkedin";

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

  // Resolve the target conversation ID up-front so attachments can be
  // filed under a stable path even when we end up in the unlinked branch.
  const conversationId = externalConversationId
    || (entityId ? `li_${entityId}` : `li_unknown_${senderId}`);

  // Best-effort attachment download. We only fetch when the event actually
  // includes an attachments array; Unipile sends this inline on new_message
  // events for most LinkedIn account types.
  const rawAttachments: any[] = Array.isArray(messageData.attachments)
    ? messageData.attachments
    : Array.isArray(messageData.files)
      ? messageData.files
      : [];
  const unipileAccountId: string | null =
    messageData.account_id ?? event.account_id ?? event.data?.account_id ?? null;

  let attachmentsForDb: UploadedAttachment[] = [];
  if (rawAttachments.length > 0) {
    try {
      const baseUrl = await getUnipileBaseUrl();
      const apiKey = await getAppSetting("UNIPILE_API_KEY");
      attachmentsForDb = await fetchAndUploadUnipileAttachments(
        supabase,
        baseUrl,
        apiKey,
        unipileAccountId,
        externalMessageId ?? null,
        rawAttachments,
        conversationId,
      );
    } catch (err: any) {
      // Never let attachment handling block message logging.
      logger.warn("Unipile attachment pipeline errored", { error: err?.message });
    }
  }

  // Handle unknown sender — create unlinked conversation and message
  if (!entityId) {
    logger.info("No matching entity for LinkedIn sender, creating unlinked conversation", { senderId });

    const senderName = messageData.sender_name || messageData.from?.name || messageData.from?.display_name || null;
    const senderAddress = messageData.sender_address || messageData.from?.identifier || messageData.from?.profile_url || senderId;

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
      attachments: attachmentsForDb,
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

  // Determine or create conversation (conversationId was resolved above so
  // attachments land under a stable path regardless of link state).
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
    attachments: attachmentsForDb,
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
// V2 Sequence: Advance enrollment on connection accepted
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
    const currentNodeId = enrollment.current_node_id;
    if (!currentNodeId) continue;

    // Find connection_accepted branch from current node
    const { data: branch } = await supabase
      .from("sequence_branches")
      .select("*, sequence_nodes!to_node_id(*)")
      .eq("from_node_id", currentNodeId)
      .eq("condition", "connection_accepted")
      .maybeSingle();

    if (!branch || !branch.to_node_id) continue;

    const nextNode = branch.sequence_nodes;
    if (!nextNode) continue;

    const sequence = enrollment.sequences;

    // Update enrollment to next node
    await supabase
      .from("sequence_enrollments")
      .update({ current_node_id: nextNode.id })
      .eq("id", enrollment.id);

    // Get the actions on the next node and schedule them with post-connection timing
    const { data: actions } = await supabase
      .from("sequence_actions")
      .select("*")
      .eq("node_id", nextNode.id);

    if (actions) {
      for (const action of actions) {
        const scheduledAt = await calculatePostConnectionSendTime(supabase, {
          connectionAcceptedAt: receivedAt,
          hardcodedHours: Number(action.post_connection_hardcoded_hours) || 4,
          delayIntervalMinutes: action.delay_interval_minutes || 0,
          jiggleMinutes: action.jiggle_minutes || 0,
          channel: action.channel,
          respectSendWindow: action.respect_send_window,
          sendWindowStart: sequence.send_window_start || "09:00",
          sendWindowEnd: sequence.send_window_end || "18:00",
          accountId: sequence.created_by,
        });

        await supabase.from("sequence_step_logs").insert({
          enrollment_id: enrollment.id,
          action_id: action.id,
          node_id: nextNode.id,
          channel: action.channel,
          scheduled_at: scheduledAt.toISOString(),
          status: "scheduled",
        });
      }
    }

    logger.info("Advanced enrollment on connection accepted", {
      enrollmentId: enrollment.id,
      nextNodeId: nextNode.id,
    });
  }
}
