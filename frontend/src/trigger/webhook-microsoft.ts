import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getMicrosoftGraphCredentials, getAnthropicKey } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";
import { stopEnrollment } from "./sequence-scheduler";

interface MicrosoftWebhookPayload {
  notification: {
    subscriptionId?: string;
    changeType?: string;
    resource?: string;
    resourceData?: any;
    clientState?: string;
    tenantId?: string;
  };
  receivedAt: string;
}

/**
 * Process Microsoft Graph notifications (email, calendar events).
 * Tenant: emeraldrecruit.com (Chris, Nancy, Ashley).
 * Matches sender email to candidates/contacts and logs activity.
 */
export const processMicrosoftEvent = task({
  id: "process-microsoft-event",
  retry: { maxAttempts: 3 },
  run: async (payload: MicrosoftWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const { notification } = payload;

    logger.info("Processing Microsoft Graph notification", {
      changeType: notification.changeType,
      resource: notification.resource,
    });

    // Verify client state if present (set during Graph subscription creation)
    // The client state is embedded in the subscription, not a separate secret
    if (notification.clientState) {
      logger.info("Notification client state present", { clientState: notification.clientState });
    }

    // Get access token for the emeraldrecruit.com tenant
    const accessToken = await getMicrosoftAccessToken();
    if (!accessToken) {
      throw new Error("Could not obtain Microsoft Graph access token");
    }

    // Fetch the full resource from Graph API
    const resourceUrl = `https://graph.microsoft.com/v1.0/${notification.resource}`;
    const resourceResp = await fetch(resourceUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resourceResp.ok) {
      // 404 = resource deleted or no longer available — skip silently
      if (resourceResp.status === 404) {
        logger.info("Resource not found (likely deleted)", { resource: notification.resource });
        return { action: "skipped", reason: "resource_not_found" };
      }
      logger.error("Failed to fetch resource", {
        status: resourceResp.status,
        resource: notification.resource,
      });
      throw new Error(`Graph API error: ${resourceResp.status}`);
    }

    const resourceData = await resourceResp.json();

    // Route based on resource type
    if (notification.resource?.includes("/messages")) {
      return await processEmailMessage(supabase, resourceData, payload.receivedAt, resourceUrl, accessToken);
    }

    if (notification.resource?.includes("/events")) {
      return await processCalendarEvent(supabase, resourceData, payload.receivedAt);
    }

    logger.info("Unhandled resource type", { resource: notification.resource });
    return { action: "skipped", reason: "unhandled_resource_type" };
  },
});

const MESSAGE_ATTACHMENTS_BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB — skip anything larger

/**
 * Fetch file attachments for a Graph message, upload them to Supabase Storage,
 * and return the metadata array to be persisted on the message row.
 */
async function fetchAndUploadAttachments(
  supabase: any,
  resourceUrl: string,
  accessToken: string,
  conversationId: string,
  externalId: string,
): Promise<Array<{ name: string; storage_path: string; mime_type: string | null; size: number | null }>> {
  let attachments: any[];
  try {
    const resp = await fetch(`${resourceUrl}/attachments`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      logger.warn("Could not fetch Graph attachments", { status: resp.status });
      return [];
    }
    const json = await resp.json();
    attachments = json.value || [];
  } catch (err: any) {
    logger.warn("Error fetching Graph attachments", { error: err.message });
    return [];
  }

  const result: Array<{ name: string; storage_path: string; mime_type: string | null; size: number | null }> = [];

  for (const att of attachments) {
    // Only handle file attachments (not item-attachments / reference-attachments)
    if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
    if (!att.contentBytes || !att.name) continue;
    if (att.size && att.size > MAX_ATTACHMENT_BYTES) {
      logger.warn("Skipping oversized inbound attachment", { name: att.name, size: att.size });
      continue;
    }

    // Decode base64 → Buffer (Node.js Buffer satisfies Uint8Array so Supabase Storage accepts it)
    const fileBuffer = Buffer.from(att.contentBytes as string, "base64");

    // Build a deterministic, safe storage path
    const safeName = (att.name as string).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeExtId = (externalId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const storagePath = `inbound/${conversationId}/${safeExtId}/${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(MESSAGE_ATTACHMENTS_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: att.contentType || "application/octet-stream",
        upsert: true,
      });

    if (uploadError) {
      logger.warn("Failed to upload inbound attachment", { name: att.name, error: uploadError.message });
      continue;
    }

    result.push({
      name: att.name as string,
      storage_path: storagePath,
      mime_type: att.contentType || null,
      size: att.size || null,
    });
  }

  logger.info("Inbound attachments uploaded", { conversationId, count: result.length });
  return result;
}

async function processEmailMessage(
  supabase: any,
  message: any,
  receivedAt: string,
  resourceUrl: string,
  accessToken: string,
) {
  const senderEmail = message.from?.emailAddress?.address?.toLowerCase();
  if (!senderEmail) {
    return { action: "skipped", reason: "no_sender_email" };
  }

  // ── Bounce / NDR detection ──────────────────────────────────────
  const subject = (message.subject || "").toLowerCase();
  const isBounce =
    subject.startsWith("undeliverable") ||
    subject.startsWith("delivery status notification") ||
    subject.startsWith("mail delivery failed") ||
    subject.startsWith("returned mail") ||
    senderEmail.includes("postmaster") ||
    senderEmail.includes("mailer-daemon");

  if (isBounce) {
    // Extract the bounced email from the body
    const bodyText = (message.body?.content || message.bodyPreview || "");
    const emailPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
    const foundEmails = bodyText.match(emailPattern) || [];
    // Filter out our own domain and system addresses
    const bouncedEmail = foundEmails.find(
      (e: string) =>
        !e.toLowerCase().includes("emeraldrecruit") &&
        !e.toLowerCase().includes("postmaster") &&
        !e.toLowerCase().includes("mailer-daemon"),
    )?.toLowerCase();

    if (bouncedEmail) {
      // Find the contact/candidate with this email
      const match = await matchByEmail(supabase, bouncedEmail);
      if (match) {
        // Stop any active sequence enrollments for this entity
        const { data: enrollments } = await supabase
          .from("sequence_enrollments")
          .select("id")
          .eq(match.entityColumn, match.entityId)
          .eq("status", "active");

        for (const enrollment of enrollments || []) {
          await supabase
            .from("sequence_enrollments")
            .update({
              status: "stopped",
              stopped_reason: "email_bounced",
              completed_at: receivedAt,
            } as any)
            .eq("id", enrollment.id);

          // Mark executions as bounced
          await supabase
            .from("sequence_step_executions")
            .update({ status: "bounced" } as any)
            .eq("enrollment_id", enrollment.id)
            .in("status", ["sent", "delivered", "scheduled"]);
        }

        logger.info("Bounce detected — enrollment stopped", {
          bouncedEmail,
          entityId: match.entityId,
          stoppedCount: (enrollments || []).length,
        });
        return { action: "bounce_handled", bouncedEmail, entityId: match.entityId };
      }
    }

    logger.info("Bounce notification — no matching entity", { subject: message.subject });
    return { action: "skipped", reason: "bounce_no_match" };
  }

  // Match sender to candidate or contact
  const match = await matchByEmail(supabase, senderEmail);

  if (!match) {
    logger.info("No matching entity for email", { email: senderEmail });
    return { action: "no_match", email: senderEmail };
  }

  // Check for duplicate message (by external ID)
  const externalId = message.id || message.internetMessageId;
  if (externalId) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("external_message_id", externalId)
      .limit(1);
    if (existing && existing.length > 0) {
      return { action: "skipped", reason: "duplicate" };
    }
  }

  // Determine or create conversation
  const conversationId = `graph_${match.entityId}`;
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (!existingConv) {
    await supabase.from("conversations").insert({
      id: conversationId,
      [match.entityColumn]: match.entityId,
      channel: "email",
      last_message_at: receivedAt,
    } as any);
  }

  // Fetch and upload inbound file attachments (best-effort — never blocks message logging)
  const attachmentsForDb = message.hasAttachments
    ? await fetchAndUploadAttachments(supabase, resourceUrl, accessToken, conversationId, externalId || "")
    : [];

  // Insert message
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    [match.entityColumn]: match.entityId,
    channel: "email",
    direction: "inbound",
    subject: message.subject || null,
    body: message.body?.content || message.bodyPreview || "",
    sender_address: senderEmail,
    recipient_address: message.toRecipients?.[0]?.emailAddress?.address || "",
    sent_at: message.receivedDateTime || receivedAt,
    provider: "microsoft_graph",
    external_message_id: externalId,
    is_read: message.isRead || false,
    attachments: attachmentsForDb,
  } as any);

  // Update conversation
  await supabase
    .from("conversations")
    .update({
      last_message_at: receivedAt,
      last_message_preview: (message.bodyPreview || "").substring(0, 100),
      is_read: false,
    })
    .eq("id", conversationId);

  // Update entity timestamps
  const table = match.entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: "email",
    } as any)
    .eq("id", match.entityId);

  // Extract intelligence from inbound email (sentiment + comp, motivation, location, etc.)
  const emailBody = message.body?.content || message.bodyPreview || "";
  if (emailBody.length > 10) {
    const intel = await extractMessageIntel(emailBody, message.subject);
    if (intel) {
      // Find active enrollment for this entity (if any)
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
        intel, "email", enrollment?.id,
      );
    }
  }

  // V2: Universal stop rule — any email reply stops active enrollments
  const { data: activeEnrollments } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq(match.entityColumn, match.entityId)
    .eq("status", "active");

  if (activeEnrollments && activeEnrollments.length > 0) {
    for (const enrollment of activeEnrollments) {
      await stopEnrollment(supabase, enrollment, "reply_received", emailBody);
    }
    logger.info("Stopped enrollments on email reply", {
      entityId: match.entityId,
      count: activeEnrollments.length,
    });
  }

  logger.info("Email logged", { entityId: match.entityId, subject: message.subject });

  // Chain-trigger Joe Says refresh
  await generateJoeSays.trigger({
    entityId: match.entityId,
    entityType: match.entityType as "candidate" | "contact",
  });

  return { action: "logged", entityId: match.entityId, type: "email" };
}

async function processCalendarEvent(supabase: any, event: any, receivedAt: string) {
  // Extract attendee emails and try to match
  const attendees = event.attendees || [];
  const matches: any[] = [];

  for (const attendee of attendees) {
    const email = attendee.emailAddress?.address?.toLowerCase();
    if (email) {
      const match = await matchByEmail(supabase, email);
      if (match) matches.push({ ...match, email });
    }
  }

  if (matches.length === 0) {
    return { action: "no_match", reason: "no_matching_attendees" };
  }

  // Dedup by event ID to avoid duplicate tasks on updates
  const externalEventId = event.id || event.iCalUId;
  if (externalEventId) {
    const { data: existing } = await supabase
      .from("tasks")
      .select("id")
      .eq("external_id", externalEventId)
      .limit(1);
    if (existing?.length) {
      return { action: "skipped", reason: "duplicate_calendar_event" };
    }
  }

  // Create tasks for matched entities (calendar events → tasks)
  for (const match of matches) {
    await supabase.from("tasks").insert({
      title: event.subject || "Calendar Event",
      description: `Calendar event with ${match.email}: ${event.bodyPreview || ""}`,
      [match.entityColumn]: match.entityId,
      due_date: event.start?.dateTime || null,
      status: "pending",
      task_type: "meeting",
      created_at: receivedAt,
      external_id: externalEventId || null,
    } as any);

    // V2: Calendar booking stops active enrollments
    const { data: activeEnrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");

    if (activeEnrollments && activeEnrollments.length > 0) {
      for (const enrollment of activeEnrollments) {
        // Stop with calendar_booked trigger
        await supabase
          .from("sequence_enrollments")
          .update({
            status: "stopped",
            stop_trigger: "calendar_booked",
            stop_reason: "Calendar event detected via Microsoft Graph",
            stopped_at: new Date().toISOString(),
          })
          .eq("id", enrollment.id);

        // Cancel pending sends
        await supabase
          .from("sequence_step_logs")
          .update({ status: "cancelled" })
          .eq("enrollment_id", enrollment.id)
          .eq("status", "scheduled");

        // Log sentiment as booked_meeting
        await supabase
          .from("sequence_step_logs")
          .update({
            sentiment: "booked_meeting",
            sentiment_reason: "Calendar event detected via Microsoft Graph",
          })
          .eq("enrollment_id", enrollment.id)
          .eq("status", "sent")
          .order("sent_at", { ascending: false })
          .limit(1);
      }

      logger.info("Stopped enrollments on calendar booking", {
        entityId: match.entityId,
        count: activeEnrollments.length,
      });
    }
  }

  logger.info("Calendar event processed", { matchCount: matches.length });
  return { action: "logged", type: "calendar", matchCount: matches.length };
}

async function getMicrosoftAccessToken(): Promise<string | null> {
  try {
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });

    if (!resp.ok) {
      logger.error("Microsoft token error", { status: resp.status });
      return null;
    }

    const data = await resp.json();
    return data.access_token;
  } catch (err: any) {
    logger.error("Failed to get Microsoft credentials from app_settings", { error: err.message });
    return null;
  }
}

async function matchByEmail(
  supabase: any,
  email: string,
): Promise<{ entityId: string; entityType: string; entityColumn: string } | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const [candidateRes, contactRes] = await Promise.all([
    supabase.from("candidates").select("id").ilike("email", normalizedEmail).limit(1),
    supabase.from("contacts").select("id").ilike("email", normalizedEmail).limit(1),
  ]);

  if (candidateRes.data?.[0]) {
    return { entityId: candidateRes.data[0].id, entityType: "candidate", entityColumn: "candidate_id" };
  }
  if (contactRes.data?.[0]) {
    return { entityId: contactRes.data[0].id, entityType: "contact", entityColumn: "contact_id" };
  }

  return null;
}
