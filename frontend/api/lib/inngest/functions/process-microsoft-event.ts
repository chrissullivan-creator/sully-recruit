import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getMicrosoftGraphCredentials,
  getAppSetting,
} from "../../../../src/trigger/lib/supabase.js";
import {
  extractMessageIntel,
  applyExtractedIntel,
} from "../../../../src/trigger/lib/intel-extraction.js";
import { stopEnrollment } from "../../../../src/trigger/lib/sequence-runner.js";
import {
  matchPersonByEmail,
  classifyEmail,
} from "../../../../src/trigger/lib/match-person-by-email.js";

/**
 * Process Microsoft Graph notifications (email, calendar events).
 * Tenant: emeraldrecruit.com (Chris, Nancy, Ashley).
 *
 * Fires `ai/joe-says.requested` after every logged inbound email and
 * `ai/resume-ingestion.requested` for each resume attachment that
 * lands in the resumes-inbox short-circuit.
 */
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

export const processMicrosoftEvent = inngest.createFunction(
  {
    id: "process-microsoft-event",
    name: "Process inbound Microsoft Graph webhook (Inngest)",
    retries: 3,
  },
  { event: "webhooks/microsoft.received" },
  async ({ event, logger }) => {
    const payload = event.data as MicrosoftWebhookPayload;
    const supabase = getSupabaseAdmin();
    const { notification } = payload;

    logger.info("Processing Microsoft Graph notification", {
      changeType: notification.changeType,
      resource: notification.resource,
    });

    if (notification.clientState) {
      logger.info("Notification client state present", { clientState: notification.clientState });
    }

    const accessToken = await getMicrosoftAccessToken(logger);
    if (!accessToken) {
      throw new Error("Could not obtain Microsoft Graph access token");
    }

    const resourceUrl = `https://graph.microsoft.com/v1.0/${notification.resource}`;
    const resourceResp = await fetch(resourceUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resourceResp.ok) {
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

    if (notification.resource?.includes("/messages")) {
      // Phase C kill-switch: when Unipile v2 has verifiably full email
      // coverage (watch v_email_ingest_coverage), flip
      // EMAIL_INGEST_MICROSOFT_GRAPH_ENABLED=false in app_settings to
      // short-circuit this branch and run Unipile-only. Calendar branch
      // below is unaffected — Graph is still the only path for events.
      const graphEmailEnabled = (await getAppSetting("EMAIL_INGEST_MICROSOFT_GRAPH_ENABLED").catch(() => "true")) !== "false";
      if (!graphEmailEnabled) {
        logger.info("MS Graph email ingest disabled by kill-switch", { resource: notification.resource });
        return { action: "skipped", reason: "graph_email_kill_switch" };
      }
      return await processEmailMessage(supabase, resourceData, payload.receivedAt, resourceUrl, accessToken, logger);
    }

    if (notification.resource?.includes("/events")) {
      return await processCalendarEvent(supabase, resourceData, payload.receivedAt, logger);
    }

    logger.info("Unhandled resource type", { resource: notification.resource });
    return { action: "skipped", reason: "unhandled_resource_type" };
  },
);

const MESSAGE_ATTACHMENTS_BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

async function fetchAndUploadAttachments(
  supabase: any,
  resourceUrl: string,
  accessToken: string,
  conversationId: string,
  externalId: string,
  logger: any,
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
    if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
    if (!att.contentBytes || !att.name) continue;
    if (att.size && att.size > MAX_ATTACHMENT_BYTES) {
      logger.warn("Skipping oversized inbound attachment", { name: att.name, size: att.size });
      continue;
    }

    const fileBuffer = Buffer.from(att.contentBytes as string, "base64");

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

const RESUME_FILE_EXTS = [".pdf", ".doc", ".docx"];
const RESUMES_BUCKET = "resumes";

async function getResumesInboxEmails(): Promise<Set<string> | null> {
  try {
    const raw = await getAppSetting("RESUMES_INBOX_EMAIL");
    if (!raw) return null;
    const set = new Set(
      raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    return set.size > 0 ? set : null;
  } catch {
    return null;
  }
}

async function processResumesInboxEmail(
  supabase: any,
  message: any,
  resourceUrl: string,
  accessToken: string,
  senderEmail: string,
  recipientEmail: string,
  logger: any,
): Promise<{ created: number; skipped: number }> {
  const sourceMessageId: string | null = message.id || message.internetMessageId || null;
  let attachments: any[] = [];
  try {
    const resp = await fetch(`${resourceUrl}/attachments`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      logger.warn("Resumes inbox: could not list attachments", { status: resp.status });
      return { created: 0, skipped: 0 };
    }
    const json = await resp.json();
    attachments = json.value || [];
  } catch (err: any) {
    logger.warn("Resumes inbox: attachments fetch failed", { error: err.message });
    return { created: 0, skipped: 0 };
  }

  const resumeAtts = attachments.filter((a: any) => {
    if (a["@odata.type"] !== "#microsoft.graph.fileAttachment") return false;
    if (!a.name || !a.contentBytes) return false;
    if (a.size && a.size > MAX_ATTACHMENT_BYTES) return false;
    const lower = String(a.name).toLowerCase();
    return RESUME_FILE_EXTS.some((ext) => lower.endsWith(ext));
  });

  if (resumeAtts.length === 0) return { created: 0, skipped: 0 };

  const senderDisplay = (message.from?.emailAddress?.name as string) || "";
  const lowerSender = senderEmail.toLowerCase();

  const { data: forwarderProfile } = await supabase
    .from("profiles")
    .select("id, full_name")
    .ilike("email", lowerSender)
    .maybeSingle();
  const isForward = !!forwarderProfile?.id;
  const forwarderUserId: string | null = forwarderProfile?.id ?? null;

  let candidateId: string;

  if (isForward) {
    const { data: created, error: createErr } = await supabase
      .from("people")
      .insert({
        type: "candidate",
        full_name: "Pending résumé parse",
        status: "new",
        source: "resumes_inbox",
        source_detail: recipientEmail,
        is_stub: true,
        owner_user_id: forwarderUserId,
        created_by_user_id: forwarderUserId,
      } as any)
      .select("id")
      .single();
    if (createErr || !created?.id) {
      logger.error("Resumes inbox: failed to create forwarded stub", {
        senderEmail,
        error: createErr?.message,
      });
      return { created: 0, skipped: 0 };
    }
    candidateId = created.id;
  } else {
    const [firstNameGuess, ...rest] = senderDisplay.trim().split(/\s+/);
    const lastNameGuess = rest.join(" ") || senderEmail.split("@")[0];

    const existingMatch = await matchPersonByEmail(supabase, senderEmail);
    if (existingMatch?.entityId) {
      candidateId = existingMatch.entityId;
    } else {
      const { data: created, error: createErr } = await supabase
        .from("people")
        .insert({
          type: "candidate",
          first_name: firstNameGuess || null,
          last_name: lastNameGuess || null,
          full_name: senderDisplay || senderEmail,
          ...classifyEmail(senderEmail),
          status: "new",
          source: "resumes_inbox",
          source_detail: recipientEmail,
          is_stub: true,
        } as any)
        .select("id")
        .single();
      if (createErr || !created?.id) {
        logger.error("Resumes inbox: failed to create candidate stub", {
          senderEmail,
          error: createErr?.message,
        });
        return { created: 0, skipped: 0 };
      }
      candidateId = created.id;
    }
  }

  let created = 0;
  let skipped = 0;

  for (const att of resumeAtts) {
    const fileName = att.name as string;

    if (sourceMessageId) {
      const { data: existingResume } = await supabase
        .from("resumes")
        .select("id")
        .eq("source_message_id", sourceMessageId)
        .eq("file_name", fileName)
        .maybeSingle();
      if (existingResume?.id) {
        skipped++;
        continue;
      }
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `inbox/${candidateId}/${Date.now()}_${safeName}`;
    const buffer = Buffer.from(att.contentBytes as string, "base64");

    const { error: upErr } = await supabase.storage
      .from(RESUMES_BUCKET)
      .upload(storagePath, buffer, {
        contentType: att.contentType || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      logger.warn("Resumes inbox: storage upload failed", { fileName, error: upErr.message });
      skipped++;
      continue;
    }

    const { data: resumeRow, error: resErr } = await supabase
      .from("resumes")
      .insert({
        candidate_id: candidateId,
        file_path: storagePath,
        file_name: fileName,
        mime_type: att.contentType || null,
        parsing_status: "pending",
        source_message_id: sourceMessageId,
      } as any)
      .select("id")
      .single();
    if (resErr || !resumeRow?.id) {
      if ((resErr as any)?.code === "23505") {
        skipped++;
      } else {
        logger.warn("Resumes inbox: resumes row insert failed", { fileName, error: resErr?.message });
        skipped++;
      }
      await supabase.storage.from(RESUMES_BUCKET).remove([storagePath]);
      continue;
    }

    await inngest.send({
      name: "ai/resume-ingestion.requested",
      data: {
        resumeId: resumeRow.id,
        candidateId,
        filePath: storagePath,
        fileName,
      },
    });
    created++;
  }

  logger.info("Resumes inbox processed", { senderEmail, candidateId, created, skipped });
  return { created, skipped };
}

async function processEmailMessage(
  supabase: any,
  message: any,
  receivedAt: string,
  resourceUrl: string,
  accessToken: string,
  logger: any,
) {
  const senderEmail = message.from?.emailAddress?.address?.toLowerCase();
  if (!senderEmail) {
    return { action: "skipped", reason: "no_sender_email" };
  }

  const bounce = await maybeHandleBounce(supabase, message, senderEmail, logger);
  if (bounce) {
    return { action: "bounce_handled", recipient: bounce.failedRecipient, reason: bounce.reason };
  }

  // Cloudflare Email Routing rewrites From: to a forwarder address —
  // prefer Reply-To when available so we still match the real sender.
  const FORWARDER_DOMAINS = ["cloudflareemail.com", "cloudflarenet.com"];
  const isFromForwarder = FORWARDER_DOMAINS.some((d) => senderEmail.endsWith("@" + d));
  let effectiveSender = senderEmail;
  if (isFromForwarder) {
    const replyTo = (message.replyTo || []).map((r: any) => r?.emailAddress?.address?.toLowerCase()).filter(Boolean)[0];
    if (replyTo) {
      logger.info("Webhook: From is a forwarder; using Reply-To as sender", { from: senderEmail, replyTo });
      effectiveSender = replyTo;
    }
  }

  const toRecipients: string[] = (message.toRecipients || [])
    .map((r: any) => r?.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const headerToValues: string[] = (message.internetMessageHeaders || [])
    .filter((h: any) => typeof h?.name === "string" && /^to$/i.test(h.name))
    .map((h: any) => String(h.value || "").toLowerCase());
  const headerEmails = headerToValues.flatMap((line) =>
    Array.from(line.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)).map((m) => m[0].toLowerCase()),
  );
  const recipientEmails = Array.from(new Set([...toRecipients, ...headerEmails]));

  const resumesInbox = await getResumesInboxEmails();
  const matchedInbox = resumesInbox
    ? recipientEmails.find((r) => resumesInbox.has(r))
    : null;
  if (matchedInbox) {
    await processResumesInboxEmail(
      supabase,
      message,
      resourceUrl,
      accessToken,
      effectiveSender,
      matchedInbox,
      logger,
    );
  }

  // Legacy bounce-by-subject path (kept for safety; maybeHandleBounce
  // covers the modern cases above).
  const subject = (message.subject || "").toLowerCase();
  const isBounce =
    subject.startsWith("undeliverable") ||
    subject.startsWith("delivery status notification") ||
    subject.startsWith("mail delivery failed") ||
    subject.startsWith("returned mail") ||
    senderEmail.includes("postmaster") ||
    senderEmail.includes("mailer-daemon");

  if (isBounce) {
    const bodyText = (message.body?.content || message.bodyPreview || "");
    const emailPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
    const foundEmails = bodyText.match(emailPattern) || [];
    const bouncedEmail = foundEmails.find(
      (e: string) =>
        !e.toLowerCase().includes("emeraldrecruit") &&
        !e.toLowerCase().includes("postmaster") &&
        !e.toLowerCase().includes("mailer-daemon"),
    )?.toLowerCase();

    if (bouncedEmail) {
      const match = await matchByEmail(supabase, bouncedEmail);
      if (match) {
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
              stop_trigger: "email_bounced",
              stop_reason: "email_bounced",
              stopped_at: receivedAt,
            } as any)
            .eq("id", enrollment.id);

          await supabase
            .from("sequence_step_logs")
            .update({ status: "cancelled" } as any)
            .eq("enrollment_id", enrollment.id)
            .in("status", ["scheduled", "pending_connection"]);
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

  const match = await matchByEmail(supabase, senderEmail);

  if (!match) {
    logger.info("No matching entity for email", { email: senderEmail });
    return { action: "no_match", email: senderEmail };
  }

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

  const attachmentsForDb = message.hasAttachments
    ? await fetchAndUploadAttachments(supabase, resourceUrl, accessToken, conversationId, externalId || "", logger)
    : [];

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

  await supabase
    .from("conversations")
    .update({
      last_message_at: receivedAt,
      last_message_preview: (message.bodyPreview || "").substring(0, 100),
      is_read: false,
    })
    .eq("id", conversationId);

  const table = match.entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: "email",
    } as any)
    .eq("id", match.entityId);

  const emailBody = message.body?.content || message.bodyPreview || "";
  if (emailBody.length > 10) {
    const intel = await extractMessageIntel(emailBody, message.subject);
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
        supabase,
        match.entityId,
        match.entityType as "candidate" | "contact",
        intel,
        "email",
        enrollment?.id,
      );
    }
  }

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

  await inngest.send({
    name: "ai/joe-says.requested",
    data: {
      entityId: match.entityId,
      entityType: match.entityType as "candidate" | "contact",
    },
  });

  return { action: "logged", entityId: match.entityId, type: "email" };
}

async function processCalendarEvent(supabase: any, event: any, receivedAt: string, logger: any) {
  const attendees = event.attendees || [];
  const matches: { entityId: string; entityType: string; entityColumn: string; email: string }[] = [];

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

  const startDt = event.start?.dateTime || "";
  const endDt = event.end?.dateTime || "";
  const dateOnly = startDt ? startDt.slice(0, 10) : null;
  const locationText = event.location?.displayName || "";
  const meetingUrl = event.onlineMeetingUrl || event.onlineMeeting?.joinUrl || "";
  const attendeeNames = matches.map((m) => m.email).join(", ");

  const { data: taskData, error: taskErr } = await supabase
    .from("tasks")
    .insert({
      title: event.subject || "Calendar Event",
      description: `Calendar event with ${attendeeNames}: ${(event.bodyPreview || "").slice(0, 500)}`,
      due_date: dateOnly,
      start_time: startDt ? (startDt.endsWith("Z") ? startDt : startDt + "Z") : null,
      end_time: endDt ? (endDt.endsWith("Z") ? endDt : endDt + "Z") : null,
      timezone: event.start?.timeZone || "UTC",
      status: "pending",
      task_type: "meeting",
      location: locationText || null,
      meeting_url: meetingUrl || null,
      external_id: externalEventId || null,
      created_at: receivedAt,
    } as any)
    .select("id")
    .single();

  if (taskErr || !taskData) {
    logger.error("Failed to create calendar task", { error: taskErr?.message });
    return { action: "error", reason: "task_insert_failed" };
  }

  for (const match of matches) {
    await supabase.from("meeting_attendees").insert({
      task_id: taskData.id,
      entity_type: match.entityType,
      entity_id: match.entityId,
    } as any);

    await supabase.from("task_links").insert({
      task_id: taskData.id,
      entity_type: match.entityType,
      entity_id: match.entityId,
    } as any);

    const { data: activeEnrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");

    if (activeEnrollments && activeEnrollments.length > 0) {
      for (const enrollment of activeEnrollments) {
        await supabase
          .from("sequence_enrollments")
          .update({
            status: "stopped",
            stop_trigger: "calendar_booked",
            stop_reason: "Calendar event detected via Microsoft Graph",
            stopped_at: new Date().toISOString(),
          })
          .eq("id", enrollment.id);

        await supabase
          .from("sequence_step_logs")
          .update({ status: "cancelled" })
          .eq("enrollment_id", enrollment.id)
          .in("status", ["scheduled", "pending_connection"]);

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

  logger.info("Calendar event processed — single meeting with attendees", {
    taskId: taskData.id,
    matchCount: matches.length,
    attendees: matches.map((m) => m.email),
  });
  return { action: "logged", type: "calendar", taskId: taskData.id, matchCount: matches.length };
}

async function getMicrosoftAccessToken(logger: any): Promise<string | null> {
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
  const m = await matchPersonByEmail(supabase, email);
  return m
    ? { entityId: m.entityId, entityType: m.entityType, entityColumn: m.entityColumn }
    : null;
}

const BOUNCE_SENDER_RE = /^(postmaster|mailer-?daemon|mail\.?daemon)@/i;
const BOUNCE_SUBJECT_RE = /undeliverable|delivery (status|has|failure)|delivery has failed|returned mail|mail delivery (subsystem|failed)/i;

function extractFailedRecipient(body: string): string | null {
  const final = body.match(/Final-Recipient[^\n]*?(?:rfc822;\s*)?([\w.+-]+@[\w.-]+)/i);
  if (final?.[1]) return final[1].toLowerCase();
  const plain = body.match(/<([\w.+-]+@[\w.-]+)>[^\n]{0,200}?(?:not be delivered|undeliverable|address not found|user (?:unknown|not found)|550 5\.\d)/i);
  if (plain?.[1]) return plain[1].toLowerCase();
  const reject = body.match(/[Rr]ecipient(?: address)?[^\n]{0,40}(?:rejected|unknown)[^\n]*?([\w.+-]+@[\w.-]+)/);
  if (reject?.[1]) return reject[1].toLowerCase();
  const all = Array.from(body.matchAll(/([\w.+-]+@[\w.-]+)/g)).map((m) => m[1].toLowerCase());
  const candidate = all.find((e) => !/^(postmaster|mailer-?daemon|noreply|no-reply)@/i.test(e));
  return candidate ?? null;
}

async function extractFailedRecipientFromOriginalSubject(
  supabase: any,
  bounceSubject: string,
): Promise<string | null> {
  const cleaned = bounceSubject
    .replace(/^(undeliverable|undelivered|returned mail|mail delivery failure|delivery (status|has|failure)|delivery has failed)\s*[:\-]?\s*/i, "")
    .trim();
  if (!cleaned) return null;
  const { data } = await supabase
    .from("messages")
    .select("recipient_address")
    .eq("direction", "outbound")
    .eq("subject", cleaned)
    .not("recipient_address", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as any)?.recipient_address?.toLowerCase() ?? null;
}

async function maybeHandleBounce(
  supabase: any,
  message: any,
  senderEmail: string,
  logger: any,
): Promise<{ failedRecipient: string; reason: string } | null> {
  const subject = (message.subject || "").trim();
  const body = (message.body?.content || message.bodyPreview || "").toString();

  const senderMatches = BOUNCE_SENDER_RE.test(senderEmail);
  const subjectMatches = BOUNCE_SUBJECT_RE.test(subject);
  if (!senderMatches && !subjectMatches) return null;

  let failedRecipient = extractFailedRecipient(body);
  if (!failedRecipient) {
    failedRecipient = await extractFailedRecipientFromOriginalSubject(supabase, subject);
  }
  if (!failedRecipient) {
    logger.warn("Bounce detected but couldn't extract recipient", { senderEmail, subject });
    return null;
  }

  const bouncedMatch = await matchPersonByEmail(supabase, failedRecipient);
  const cand = bouncedMatch?.entityType !== "contact"
    ? (bouncedMatch ? { id: bouncedMatch.entityId } : null)
    : null;
  const cont = bouncedMatch?.entityType === "contact"
    ? { id: bouncedMatch.entityId }
    : null;

  const reason = subject.slice(0, 200) || "ndr";
  const now = new Date().toISOString();

  if (cand?.id) {
    await supabase
      .from("people")
      .update({
        email_invalid: true,
        email_invalid_reason: reason,
        email_invalid_at: now,
      } as any)
      .eq("id", cand.id);

    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("candidate_id", cand.id)
      .eq("status", "active");
    for (const e of enrollments ?? []) {
      await stopEnrollment(supabase, e, "email_bounced", reason);
    }
    logger.info("Bounce handled", { failedRecipient, candidateId: cand.id, stopped: (enrollments ?? []).length });
  } else if (cont?.id) {
    await supabase
      .from("contacts")
      .update({
        email_invalid: true,
        email_invalid_reason: reason,
        email_invalid_at: now,
      } as any)
      .eq("id", cont.id);
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("contact_id", cont.id)
      .eq("status", "active");
    for (const e of enrollments ?? []) {
      await stopEnrollment(supabase, e, "email_bounced", reason);
    }
    logger.info("Bounce handled (contact)", { failedRecipient, contactId: cont.id, stopped: (enrollments ?? []).length });
  } else {
    logger.info("Bounce for unknown recipient — skipped", { failedRecipient });
  }

  return { failedRecipient, reason };
}
