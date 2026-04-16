import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";
import { stopEnrollment } from "./sequence-scheduler";
import { processCallDeepgram } from "./process-call-deepgram";

interface RingCentralWebhookPayload {
  body: any;
  headers: Record<string, string | undefined>;
  receivedAt: string;
}

/**
 * Process inbound RingCentral events (calls, SMS, voicemail).
 * Matches caller phone to candidates/contacts and logs activity.
 * For completed calls: fetches recording, transcribes with Claude,
 * extracts candidate fields, generates summary, stores in notes + back_of_resume_notes.
 */
export const processRingcentralEvent = task({
  id: "process-ringcentral-event",
  retry: { maxAttempts: 3 },
  run: async (payload: RingCentralWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const event = payload.body;

    logger.info("Processing RingCentral event", { event });

    const eventBody = event.body || event;
    const eventType = eventBody.type || eventBody.event || "";

    const fromPhone = eventBody.from?.phoneNumber || eventBody.from?.extensionNumber || "";
    const fromExtension = eventBody.from?.extensionNumber || "";
    const toPhone = eventBody.to?.[0]?.phoneNumber || eventBody.to?.phoneNumber || "";
    const toExtension = eventBody.to?.[0]?.extensionNumber || eventBody.to?.extensionNumber || "";
    const direction = eventBody.direction === "Inbound" ? "inbound" : "outbound";
    const otherPhone = direction === "inbound" ? fromPhone : toPhone;
    // User-side identity (which Sully user this event belongs to)
    const userPhone = direction === "inbound" ? toPhone : fromPhone;
    const userExtension = direction === "inbound" ? toExtension : fromExtension;

    const isSmsEvent = eventType.includes("SMS") || eventBody.messageType === "SMS";

    // Resolve owner_id from integration_accounts (provider='sms', match extension or phone).
    const ownerId = await lookupOwnerId(supabase, userExtension, userPhone);

    if (!otherPhone) {
      logger.info("No phone number in event — skipping");
      return { action: "skipped", reason: "no_phone" };
    }

    const normalizedPhone = otherPhone.replace(/[^0-9+]/g, "");
    const match = await matchByPhone(supabase, normalizedPhone);

    // ── CALL event with no match: still log as Unknown (never drop) ────
    if (!match && !isSmsEvent) {
      const { data: callLog, error: callLogError } = await supabase
        .from("call_logs")
        .insert({
          linked_entity_id: null,
          linked_entity_type: null,
          linked_entity_name: "Unknown",
          direction,
          phone_number: otherPhone,
          status: eventBody.result || eventBody.status || "completed",
          duration_seconds: eventBody.duration || 0,
          started_at: eventBody.startTime || payload.receivedAt,
          ended_at: eventBody.endTime || null,
          external_call_id: eventBody.id?.toString(),
          owner_id: ownerId,
        } as any)
        .select("id")
        .single();

      if (callLogError) {
        logger.error("Failed to insert unmatched call_log", { error: callLogError.message });
      } else {
        logger.info("Logged unmatched call", { callLogId: callLog?.id, phone: otherPhone, ownerId });
      }

      const isCompletedCall =
        eventBody.result === "Completed" ||
        eventBody.result === "Call connected" ||
        (eventBody.duration && eventBody.duration > 30);

      if (isCompletedCall && callLog?.id) {
        await processCallDeepgram.trigger(
          { call_log_id: callLog.id },
          { delay: "30s" },
        );
      }

      return { action: "logged_unknown", phone: otherPhone, callLogId: callLog?.id };
    }

    if (!match) {
      // SMS with no match — can't attach to conversation; skip.
      logger.info("No matching entity for SMS", { phone: normalizedPhone });
      return { action: "no_match", phone: normalizedPhone };
    }

    if (isSmsEvent) {
      // ── SMS event ─────────────────────────────────────────────────
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

      const smsBody = eventBody.subject || eventBody.text || "";

      // Extract intelligence from inbound SMS
      if (direction === "inbound") {
        if (smsBody.length > 10) {
          const intel = await extractMessageIntel(smsBody);
          if (intel) {
            const { data: enrollment } = await supabase
              .from("sequence_enrollments")
              .select("id")
              .eq(match.entityColumn, match.entityId)
              .eq("status", "active")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            await applyExtractedIntel(
              supabase, match.entityId, match.entityType as "candidate" | "contact",
              intel, "sms", enrollment?.id,
            );
          }
        }
      }

      // V2: Universal stop rule — inbound SMS stops active enrollments
      if (direction === "inbound" && smsBody) {
        const { data: activeEnrollments } = await supabase
          .from("sequence_enrollments")
          .select("*, sequences!inner(*)")
          .eq(match.entityColumn, match.entityId)
          .eq("status", "active");

        if (activeEnrollments && activeEnrollments.length > 0) {
          for (const enrollment of activeEnrollments) {
            await stopEnrollment(supabase, enrollment, "reply_received", smsBody);
          }
          logger.info("Stopped enrollments on SMS reply", {
            entityId: match.entityId,
            count: activeEnrollments.length,
          });
        }
      }

      logger.info("SMS logged", { entityId: match.entityId, direction });
    } else {
      // ── Call event ────────────────────────────────────────────────
      const { data: callLog, error: callLogError } = await supabase
        .from("call_logs")
        .insert({
          [match.entityColumn]: match.entityId,
          linked_entity_type: match.entityType,
          linked_entity_id: match.entityId,
          direction,
          phone_number: otherPhone,
          status: eventBody.result || eventBody.status || "completed",
          duration_seconds: eventBody.duration || 0,
          started_at: eventBody.startTime || payload.receivedAt,
          ended_at: eventBody.endTime || null,
          external_call_id: eventBody.id?.toString(),
          owner_id: ownerId,
        } as any)
        .select("id")
        .single();

      if (callLogError) {
        logger.error("Failed to insert call_log", { error: callLogError.message });
      }

      logger.info("Call logged", { entityId: match.entityId, callLogId: callLog?.id, ownerId });

      // ── Trigger Deepgram transcription for completed calls ≥ 30s ──
      const isCompletedCall =
        eventBody.result === "Completed" ||
        eventBody.result === "Call connected" ||
        (eventBody.duration && eventBody.duration > 30);

      if (isCompletedCall && callLog?.id) {
        // Delay 30s to let RingCentral finish processing the recording
        await processCallDeepgram.trigger(
          { call_log_id: callLog.id },
          { delay: "30s" },
        );
        logger.info("Triggered Deepgram transcription", { callLogId: callLog.id });
      }
    }

    // Update last activity timestamps
    if (direction === "inbound") {
      const table = match.entityType === "candidate" ? "candidates" : "contacts";
      await supabase
        .from(table)
        .update({
          last_responded_at: payload.receivedAt,
          last_spoken_at: payload.receivedAt,
          last_comm_channel: "phone",
        } as any)
        .eq("id", match.entityId);
    } else {
      // Outbound calls still update last_spoken_at
      const table = match.entityType === "candidate" ? "candidates" : "contacts";
      await supabase
        .from(table)
        .update({
          last_contacted_at: payload.receivedAt,
          last_spoken_at: payload.receivedAt,
          last_comm_channel: "phone",
        } as any)
        .eq("id", match.entityId);
    }

    // Chain-trigger Joe Says refresh after processing communication
    await generateJoeSays.trigger({
      entityId: match.entityId,
      entityType: match.entityType as "candidate" | "contact",
    });

    return { action: "logged", entityId: match.entityId, entityType: match.entityType, direction };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// OWNER LOOKUP — map RC extension or phone to Sully user_id
// ─────────────────────────────────────────────────────────────────────────────
async function lookupOwnerId(
  supabase: any,
  extension: string,
  phone: string,
): Promise<string | null> {
  if (!extension && !phone) return null;

  const filters: string[] = [];
  if (extension) filters.push(`rc_extension.eq.${extension}`);
  if (phone) filters.push(`rc_phone_number.eq.${phone}`);
  if (filters.length === 0) return null;

  const { data, error } = await supabase
    .from("integration_accounts")
    .select("owner_user_id")
    .eq("provider", "sms")
    .or(filters.join(","))
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn("owner lookup failed", { error: error.message, extension, phone });
    return null;
  }
  return data?.owner_user_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE MATCHING — uses SQL queries instead of fetching all records
// ─────────────────────────────────────────────────────────────────────────────
async function matchByPhone(
  supabase: any,
  normalizedPhone: string,
): Promise<{ entityId: string; entityType: string; entityColumn: string } | null> {
  // Strip to digits only for matching
  const digitsOnly = normalizedPhone.replace(/[^0-9]/g, "");
  const last10 = digitsOnly.slice(-10);

  // Try exact match on candidates first (E.164 format)
  const { data: candidateExact } = await supabase
    .from("candidates")
    .select("id")
    .eq("phone", normalizedPhone)
    .limit(1)
    .maybeSingle();

  if (candidateExact) {
    return { entityId: candidateExact.id, entityType: "candidate", entityColumn: "candidate_id" };
  }

  // Try last-10-digit fuzzy match on candidates (handles format variations)
  if (last10.length === 10) {
    const { data: candidateFuzzy } = await supabase
      .from("candidates")
      .select("id")
      .ilike("phone", `%${last10}`)
      .limit(1)
      .maybeSingle();

    if (candidateFuzzy) {
      return { entityId: candidateFuzzy.id, entityType: "candidate", entityColumn: "candidate_id" };
    }
  }

  // Try exact match on contacts
  const { data: contactExact } = await supabase
    .from("contacts")
    .select("id")
    .eq("phone", normalizedPhone)
    .limit(1)
    .maybeSingle();

  if (contactExact) {
    return { entityId: contactExact.id, entityType: "contact", entityColumn: "contact_id" };
  }

  // Try last-10-digit fuzzy match on contacts
  if (last10.length === 10) {
    const { data: contactFuzzy } = await supabase
      .from("contacts")
      .select("id")
      .ilike("phone", `%${last10}`)
      .limit(1)
      .maybeSingle();

    if (contactFuzzy) {
      return { entityId: contactFuzzy.id, entityType: "contact", entityColumn: "contact_id" };
    }
  }

  return null;
}
