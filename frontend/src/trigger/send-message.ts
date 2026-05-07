import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { sendEmail, sendSms, sendLinkedIn } from "./lib/send-channels";
import { generateJoeSays } from "./generate-joe-says";

interface SendMessagePayload {
  channel: "email" | "sms" | "linkedin";
  conversationId: string;
  candidateId?: string;
  contactId?: string;
  to: string;
  subject?: string;
  body: string;
  accountId?: string;
  userId: string; // the recruiter sending the message
}

/**
 * Trigger.dev task for sending messages across channels (email, SMS, LinkedIn).
 * Migrated from supabase/functions/send-message edge function for:
 * - Retry semantics on intermittent API failures
 * - Chain-triggering Joe Says after new outbound communication
 * - Centralized monitoring via Trigger.dev dashboard
 */
export const sendMessage = task({
  id: "send-message",
  retry: { maxAttempts: 3 },
  run: async (payload: SendMessagePayload) => {
    const {
      channel,
      conversationId,
      candidateId,
      contactId,
      to,
      subject,
      body,
      accountId,
      userId,
    } = payload;

    const supabase = getSupabaseAdmin();

    logger.info("Sending message", { channel, to, userId });

    let externalMessageId: string | null = null;
    let senderAddress: string | null = null;

    // Route to appropriate channel handler
    switch (channel) {
      case "email": {
        const result = await sendEmail(supabase, to, subject, body, userId);
        externalMessageId = result.messageId;
        senderAddress = result.sender;
        break;
      }
      case "sms": {
        const result = await sendSms(supabase, to, body, userId);
        externalMessageId = result.id?.toString();
        senderAddress = result.sender;
        break;
      }
      case "linkedin": {
        const result = await sendLinkedIn(supabase, to, body, userId, accountId);
        externalMessageId = result.message_id;
        senderAddress = userId;
        break;
      }
      default:
        throw new Error(`Unsupported channel: ${channel}`);
    }

    // Log the message in database
    const { error: msgError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      candidate_id: candidateId || null,
      contact_id: contactId || null,
      channel,
      direction: "outbound",
      subject: subject || null,
      body,
      sender_address: senderAddress,
      recipient_address: to,
      sent_at: new Date().toISOString(),
      external_message_id: externalMessageId,
      provider:
        channel === "email"
          ? "microsoft_graph"
          : channel === "sms"
            ? "ringcentral"
            : "unipile",
      owner_id: userId,
    } as any);

    if (msgError) {
      logger.error("Failed to log message", { error: msgError.message });
      // Message was sent but logging failed — don't throw (message already delivered)
    }

    // Update conversation's last_message_at
    if (conversationId) {
      await supabase
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: body.substring(0, 100),
          is_read: true,
        } as any)
        .eq("id", conversationId);
    }

    // Update entity's last_contacted_at
    const entityId = candidateId || contactId;
    const entityType = candidateId ? "candidate" : "contact";
    if (entityId) {
      const table = entityType === "candidate" ? "candidates" : "contacts";
      await supabase
        .from(table)
        .update({
          last_contacted_at: new Date().toISOString(),
          last_comm_channel: channel,
        } as any)
        .eq("id", entityId);

      // Chain-trigger Joe Says refresh (new outbound = update summary).
      // Best-effort — the message was already delivered above, so a Joe Says
      // failure must not fail this run (otherwise retries would re-send).
      try {
        await generateJoeSays.trigger({
          entityId,
          entityType,
        });
      } catch (err: any) {
        logger.warn("generateJoeSays.trigger failed after send-message", {
          entityId, entityType, error: err?.message,
        });
      }
    }

    logger.info("Message sent and logged", {
      channel,
      to,
      externalMessageId,
    });

    return {
      success: true,
      channel,
      externalMessageId,
      sender: senderAddress,
    };
  },
});
