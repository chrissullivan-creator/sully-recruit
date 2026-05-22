import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  sendEmail,
  sendSms,
  sendLinkedIn,
} from "../../../../src/server-lib/send-channels.js";

interface SendMessagePayload {
  channel: "email" | "sms" | "linkedin";
  conversationId: string;
  candidateId?: string;
  contactId?: string;
  to: string;
  subject?: string;
  body: string;
  accountId?: string;
  userId: string;
}

/**
 * Outbound message dispatcher across email / SMS / LinkedIn. Logs the
 * message to `messages`, updates conversation + entity timestamps, and
 * fires `ai/joe-says.requested` so the brief stays current.
 *
 * Ported from `src/trigger/send-message.ts`. The Trigger.dev wrapper at
 * the same source path now just forwards to this Inngest function so
 * the `/api/trigger-send-message.ts` route (and any other caller using
 * `sendMessage.trigger(...)`) keeps working unchanged.
 *
 * `retries: 3` matches Trigger.dev's `maxAttempts: 3`.
 */
export const sendMessage = inngest.createFunction(
  { id: "send-message", name: "Send outbound message (Inngest)", retries: 3 },
  { event: "messages/send.requested" },
  async ({ event, logger }) => {
    const payload = event.data as SendMessagePayload;
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
      // Message was sent but logging failed — don't throw (already delivered)
    }

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

      // Best-effort Joe Says refresh — message already delivered, so a
      // failure here must not fail the run (otherwise retries re-send).
      try {
        await inngest.send({
          name: "ai/joe-says.requested",
          data: { entityId, entityType },
        });
      } catch (err: any) {
        logger.warn("ai/joe-says.requested send failed after send-message", {
          entityId,
          entityType,
          error: err?.message,
        });
      }
    }

    logger.info("Message sent and logged", { channel, to, externalMessageId });

    return {
      success: true,
      channel,
      externalMessageId,
      sender: senderAddress,
    };
  },
);
