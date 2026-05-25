import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { indexMessage, indexCall } from "../../../../src/server-lib/index-communication.js";

/**
 * Index a single message into search_documents for RAG/Joe search.
 * Fired by webhook handlers + send-message after persisting a message.
 *
 * Event data: { messageId: string }
 */
export const indexCommunicationMessage = inngest.createFunction(
  { id: "index-communication-message", name: "Index message for RAG search", retries: 2 },
  { event: "messages/indexed.requested" },
  async ({ event, logger }) => {
    const supabase = getSupabaseAdmin();
    const { messageId } = event.data as { messageId: string };
    if (!messageId) return { action: "skipped", reason: "no_message_id" };

    const { data: msg, error } = await supabase
      .from("messages")
      .select("id, conversation_id, candidate_id, contact_id, channel, direction, sender_name, subject, body, sent_at")
      .eq("id", messageId)
      .single();

    if (error || !msg) {
      logger.error("Message not found for indexing", { messageId, error: error?.message });
      return { action: "skipped", reason: "not_found" };
    }

    await indexMessage({
      messageId: msg.id,
      conversationId: msg.conversation_id,
      candidateId: msg.candidate_id,
      contactId: msg.contact_id,
      channel: msg.channel,
      direction: msg.direction,
      senderName: msg.sender_name,
      subject: msg.subject,
      body: msg.body,
      sentAt: msg.sent_at,
    });

    logger.info("Message indexed", { messageId });
    return { action: "indexed", messageId };
  },
);

/**
 * Index a call's AI summary into search_documents for RAG/Joe search.
 * Fired by the ai_call_notes sync trigger chain.
 *
 * Event data: { callLogId: string }
 */
export const indexCommunicationCall = inngest.createFunction(
  { id: "index-communication-call", name: "Index call note for RAG search", retries: 2 },
  { event: "calls/indexed.requested" },
  async ({ event, logger }) => {
    const supabase = getSupabaseAdmin();
    const { callLogId } = event.data as { callLogId: string };
    if (!callLogId) return { action: "skipped", reason: "no_call_log_id" };

    const { data: log } = await supabase
      .from("call_logs")
      .select("id, candidate_id, contact_id, direction, phone_number, linked_entity_name, started_at")
      .eq("id", callLogId)
      .single();

    if (!log) return { action: "skipped", reason: "not_found" };

    const { data: noteRow } = await supabase
      .from("ai_call_notes")
      .select("ai_summary")
      .eq("call_log_id", callLogId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    await indexCall({
      callLogId: log.id,
      candidateId: log.candidate_id,
      contactId: log.contact_id,
      direction: log.direction ?? "inbound",
      phoneNumber: log.phone_number,
      entityName: log.linked_entity_name,
      aiSummary: noteRow?.ai_summary ?? null,
      startedAt: log.started_at,
    });

    logger.info("Call indexed", { callLogId });
    return { action: "indexed", callLogId };
  },
);
