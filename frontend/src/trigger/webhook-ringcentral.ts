import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

interface RingCentralWebhookPayload {
  body: any;
  headers: Record<string, string | undefined>;
  receivedAt: string;
}

/**
 * Process inbound RingCentral events (calls, SMS, voicemail).
 * Matches caller phone to candidates/contacts and logs activity.
 *
 * Reuses match-entity logic from supabase/functions/match-entity/index.ts
 */
export const processRingcentralEvent = task({
  id: "process-ringcentral-event",
  retry: { maxAttempts: 3 },
  run: async (payload: RingCentralWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const event = payload.body;

    logger.info("Processing RingCentral event", { event });

    // RingCentral sends event body in different formats depending on subscription
    const eventBody = event.body || event;
    const eventType = eventBody.type || eventBody.event || "";

    // Extract phone number from event
    const fromPhone = eventBody.from?.phoneNumber || eventBody.from?.extensionNumber || "";
    const toPhone = eventBody.to?.[0]?.phoneNumber || eventBody.to?.phoneNumber || "";
    const direction = eventBody.direction === "Inbound" ? "inbound" : "outbound";
    const callerPhone = direction === "inbound" ? fromPhone : toPhone;

    if (!callerPhone) {
      logger.info("No phone number in event — skipping");
      return { action: "skipped", reason: "no_phone" };
    }

    // Normalize phone
    const normalizedPhone = callerPhone.replace(/[^0-9+]/g, "");

    // Match to candidate or contact
    const match = await matchByPhone(supabase, normalizedPhone);

    if (!match) {
      logger.info("No matching entity for phone", { phone: normalizedPhone });
      return { action: "no_match", phone: normalizedPhone };
    }

    // Determine event type and log accordingly
    if (eventType.includes("SMS") || eventBody.messageType === "SMS") {
      // Inbound SMS — log as message
      await supabase.from("messages").insert({
        conversation_id: `rc_sms_${match.entityId}`,
        [match.entityColumn]: match.entityId,
        channel: "sms",
        direction,
        body: eventBody.subject || eventBody.text || "",
        sender_address: fromPhone,
        recipient_address: toPhone,
        sent_at: eventBody.creationTime || payload.receivedAt,
        provider: "ringcentral",
        external_message_id: eventBody.id?.toString(),
      } as any);

      logger.info("SMS logged", { entityId: match.entityId, direction });
    } else {
      // Call event — log to call_logs
      await supabase.from("call_logs").insert({
        [match.entityColumn]: match.entityId,
        direction,
        caller_number: fromPhone,
        callee_number: toPhone,
        status: eventBody.result || eventBody.status || "completed",
        duration_seconds: eventBody.duration || 0,
        started_at: eventBody.startTime || payload.receivedAt,
        ended_at: eventBody.endTime || null,
        provider: "ringcentral",
        external_id: eventBody.id?.toString(),
      } as any);

      logger.info("Call logged", { entityId: match.entityId, direction });
    }

    // Update last activity timestamps on entity
    if (direction === "inbound") {
      const table = match.entityType === "candidate" ? "candidates" : "contacts";
      await supabase
        .from(table)
        .update({
          last_responded_at: payload.receivedAt,
          last_spoken_at: payload.receivedAt,
          last_comm_channel: "sms",
        } as any)
        .eq("id", match.entityId);
    }

    return { action: "logged", entityId: match.entityId, entityType: match.entityType, direction };
  },
});

async function matchByPhone(
  supabase: any,
  normalizedPhone: string,
): Promise<{ entityId: string; entityType: string; entityColumn: string } | null> {
  const normalize = (p: string) => p.replace(/[^0-9+]/g, "");

  // Check candidates
  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, phone")
    .not("phone", "is", null);

  const candidateMatch = candidates?.find(
    (c: any) => c.phone && normalize(c.phone) === normalizedPhone,
  );
  if (candidateMatch) {
    return { entityId: candidateMatch.id, entityType: "candidate", entityColumn: "candidate_id" };
  }

  // Check contacts
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, phone")
    .not("phone", "is", null);

  const contactMatch = contacts?.find(
    (c: any) => c.phone && normalize(c.phone) === normalizedPhone,
  );
  if (contactMatch) {
    return { entityId: contactMatch.id, entityType: "contact", entityColumn: "contact_id" };
  }

  return null;
}
