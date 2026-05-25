import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { indexMessage, indexCall } from "../../../../src/server-lib/index-communication.js";

const BATCH_SIZE = 50;

/**
 * One-shot backfill: index all messages + call notes into
 * search_documents. Idempotent — skips rows that already have an
 * embedding. Pages through both tables in batches of 50.
 *
 * Trigger manually:
 *   await inngest.send({ name: "ops/backfill-communication-index.requested" });
 *
 * Expected wall time for ~21k messages + ~525 calls at 50 req/sec
 * Voyage rate: ~10 minutes.
 */
export const backfillCommunicationIndex = inngest.createFunction(
  {
    id: "backfill-communication-index",
    name: "Backfill communication RAG index (messages + calls)",
    retries: 1,
  },
  { event: "ops/backfill-communication-index.requested" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    let totalMessages = 0;
    let totalCalls = 0;
    let offset = 0;

    // --- Messages ---
    logger.info("Starting message backfill");
    while (true) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("id, conversation_id, candidate_id, contact_id, channel, direction, sender_name, subject, body, sent_at")
        .order("created_at", { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (!msgs || msgs.length === 0) break;

      for (const msg of msgs) {
        // Skip if already indexed with an embedding
        const { data: existing } = await supabase
          .from("search_documents")
          .select("id, embedding")
          .eq("source_kind", "message")
          .eq("source_id", msg.id)
          .limit(1);

        if (existing && existing.length > 0 && existing[0].embedding) {
          // Already embedded — skip
          continue;
        }

        try {
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
          totalMessages++;
        } catch (err: any) {
          logger.warn("Message index failed, continuing", { id: msg.id, error: err?.message });
        }
      }

      offset += msgs.length;
      if (msgs.length < BATCH_SIZE) break;

      // Brief pause to respect Voyage rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    // --- Calls ---
    logger.info("Starting call backfill");
    offset = 0;
    while (true) {
      const { data: logs } = await supabase
        .from("call_logs")
        .select("id, candidate_id, contact_id, direction, phone_number, linked_entity_name, started_at")
        .order("created_at", { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (!logs || logs.length === 0) break;

      for (const log of logs) {
        const { data: existing } = await supabase
          .from("search_documents")
          .select("id, embedding")
          .eq("source_kind", "call")
          .eq("source_id", log.id)
          .limit(1);

        if (existing && existing.length > 0 && existing[0].embedding) continue;

        const { data: noteRow } = await supabase
          .from("ai_call_notes")
          .select("ai_summary")
          .eq("call_log_id", log.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        try {
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
          totalCalls++;
        } catch (err: any) {
          logger.warn("Call index failed, continuing", { id: log.id, error: err?.message });
        }
      }

      offset += logs.length;
      if (logs.length < BATCH_SIZE) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    logger.info("Backfill complete", { totalMessages, totalCalls });
    return { totalMessages, totalCalls };
  },
);
