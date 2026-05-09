import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { generateJoeSays } from "../../../../src/trigger/generate-joe-says.js";
import {
  extractMessageIntel,
  applyExtractedIntel,
} from "../../../../src/trigger/lib/intel-extraction.js";
import { stopEnrollment } from "../../../../src/trigger/lib/sequence-runner.js";
import { calculatePostConnectionSendTime } from "../../../../src/trigger/lib/send-time-calculator.js";
import { canonicalChannel } from "../../../../src/trigger/lib/unipile-v2.js";
import { matchPersonByEmail } from "../../../../src/trigger/lib/match-person-by-email.js";

/**
 * Process Unipile webhook events (LinkedIn messages, connection updates,
 * Outlook email via the Phase-3 parallel feed). Matches by provider_id /
 * email, logs to messages + conversations, runs Joe sentiment-and-intel
 * extraction on inbound, and stops active enrollments on any reply.
 *
 * Ported from `src/trigger/webhook-unipile.ts` — the API route at
 * `api/webhooks/unipile.ts` now sends `webhooks/unipile.received` and
 * Inngest drives the work. `generateJoeSays.trigger(...)` still routes
 * via Trigger.dev (will switch when generate-joe-says is ported).
 *
 * `retries: 3` matches Trigger.dev's `maxAttempts: 3`.
 */
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
  verified?: boolean;
}

export const processUnipileEvent = inngest.createFunction(
  {
    id: "process-unipile-event",
    name: "Process inbound Unipile webhook (Inngest)",
    retries: 3,
  },
  { event: "webhooks/unipile.received" },
  async ({ event, logger }) => {
    const payload = event.data as UnipileWebhookPayload;
    const supabase = getSupabaseAdmin();
    const body = payload.body;
    const eventType = body.event || body.type || "";

    logger.info("Processing Unipile event", { eventType });

    // Phase 3: email events (Unipile Outlook). Runs in PARALLEL with the
    // Graph webhook for the same mailbox until we're confident — dedup
    // happens on insert via the messages.external_message_id unique
    // constraint, so the second arrival is a no-op.
    const isEmailEvent =
      /^mail\.|^email\.|^message\.received|outlook|gmail/i.test(eventType)
      || body.data?.account_type === "OUTLOOK"
      || body.data?.account_type === "GMAIL"
      || (body.data?.attachments !== undefined && body.data?.subject !== undefined);
    if (isEmailEvent) {
      return await processUnipileEmailEvent(supabase, body, payload.receivedAt, logger);
    }

    if (eventType.includes("message") || body.message) {
      return await processLinkedInMessage(supabase, body, payload.receivedAt, logger);
    }

    if (eventType.includes("connection") || body.connection) {
      return await processConnectionUpdate(supabase, body, payload.receivedAt, logger);
    }

    logger.info("Unhandled Unipile event type", { eventType });
    return { action: "skipped", reason: "unhandled_event_type" };
  },
);

const EMAIL_BOUNCE_SENDER_RE = /^(postmaster|mailer-daemon|mail.daemon)@/i;
const EMAIL_BOUNCE_SUBJECT_RE = /undeliverable|delivery (status|has|failure)|delivery has failed|returned mail|mail delivery (subsystem|failed)/i;

function extractFailedRecipient(body: string): string | null {
  const final = body.match(/Final-Recipient[^\n]*?(?:rfc822;\s*)?([\w.+-]+@[\w.-]+)/i);
  if (final?.[1]) return final[1].toLowerCase();
  const plain = body.match(/<([\w.+-]+@[\w.-]+)>[^\n]{0,200}?(?:not be delivered|undeliverable|address not found|user (?:unknown|not found)|550 5\.\d)/i);
  if (plain?.[1]) return plain[1].toLowerCase();
  const all = Array.from(body.matchAll(/([\w.+-]+@[\w.-]+)/g)).map((m) => m[1].toLowerCase());
  const candidate = all.find((e) => !/^(postmaster|mailer-daemon|noreply|no-reply)@/i.test(e));
  return candidate ?? null;
}

async function processUnipileEmailEvent(supabase: any, event: any, receivedAt: string, logger: any) {
  const data = event.data || event.email || event;

  const fromField = data.from || data.sender || {};
  const senderEmail = String(
    fromField.identifier || fromField.email || fromField.address || "",
  ).toLowerCase();
  if (!senderEmail) {
    logger.info("Unipile email event with no sender — skipping");
    return { action: "skipped", reason: "no_sender_email" };
  }

  const toArr = Array.isArray(data.to) ? data.to : [];
  const recipientEmail = String(
    toArr[0]?.identifier || toArr[0]?.email || toArr[0]?.address || "",
  ).toLowerCase();
  const subject = data.subject || "";
  const bodyHtml = data.body || data.body_html || data.html || "";
  const bodyText = data.body_plain || data.body_text || data.text || "";
  const bodyForSearch = bodyText || bodyHtml.replace(/<[^>]+>/g, " ");
  const externalId = String(
    data.id || data.message_id || data.internet_message_id || "",
  );
  const sentAt = data.received_at || data.date || data.timestamp || receivedAt;

  const isBounce =
    EMAIL_BOUNCE_SENDER_RE.test(senderEmail) || EMAIL_BOUNCE_SUBJECT_RE.test(subject);
  if (isBounce) {
    const failed = extractFailedRecipient(bodyForSearch);
    if (failed) {
      const bouncedMatch = await matchPersonByEmail(supabase, failed);
      const cand = bouncedMatch && bouncedMatch.entityType !== "contact"
        ? { id: bouncedMatch.entityId }
        : null;
      const cont = bouncedMatch?.entityType === "contact"
        ? { id: bouncedMatch.entityId }
        : null;
      const reason = (subject || "ndr").slice(0, 200);
      const now = new Date().toISOString();
      if (cand?.id) {
        await supabase
          .from("people")
          .update({ email_invalid: true, email_invalid_reason: reason, email_invalid_at: now } as any)
          .eq("id", cand.id);
        const { data: enrollments } = await supabase
          .from("sequence_enrollments")
          .select("*, sequences!inner(*)")
          .eq("candidate_id", cand.id).eq("status", "active");
        for (const e of enrollments ?? []) await stopEnrollment(supabase, e, "email_bounced", reason);
        logger.info("Unipile bounce handled", { failed, candidateId: cand.id });
      } else if (cont?.id) {
        await supabase
          .from("contacts")
          .update({ email_invalid: true, email_invalid_reason: reason, email_invalid_at: now } as any)
          .eq("id", cont.id);
        const { data: enrollments } = await supabase
          .from("sequence_enrollments")
          .select("*, sequences!inner(*)")
          .eq("contact_id", cont.id).eq("status", "active");
        for (const e of enrollments ?? []) await stopEnrollment(supabase, e, "email_bounced", reason);
      }
      return { action: "bounce_handled", failed, recipient: recipientEmail };
    }
  }

  const senderMatch = await matchPersonByEmail(supabase, senderEmail);
  const match = senderMatch
    ? {
        entityId: senderMatch.entityId,
        entityType: senderMatch.entityType,
        entityColumn: senderMatch.entityColumn,
      }
    : null;
  if (!match) {
    logger.info("Unipile email: no entity match", { senderEmail });
    return { action: "no_match", senderEmail };
  }

  const conversationId = data.conversation_id || data.thread_id || `unipile_email_${match.entityId}`;
  const { error: insertErr } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    [match.entityColumn]: match.entityId,
    channel: "email",
    direction: "inbound",
    subject: subject || null,
    body: bodyHtml || bodyText,
    sender_address: senderEmail,
    recipient_address: recipientEmail,
    sent_at: sentAt,
    provider: "unipile",
    external_message_id: externalId,
    is_read: data.is_read ?? false,
  } as any);
  if (insertErr && !/duplicate key|23505/.test(insertErr.message)) {
    logger.warn("Unipile email insert failed", { error: insertErr.message });
  }

  const table = match.entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({ last_responded_at: receivedAt, last_comm_channel: "email" } as any)
    .eq("id", match.entityId);

  const intel = bodyForSearch.length > 10
    ? await extractMessageIntel(bodyForSearch, subject)
    : null;
  if (intel) {
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active")
      .order("enrolled_at", { ascending: false })
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

    const { data: actives } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");
    for (const e of actives ?? []) {
      await stopEnrollment(supabase, e, "reply_received", bodyForSearch.slice(0, 500));
    }
  }

  await generateJoeSays.trigger({
    entityId: match.entityId,
    entityType: match.entityType as "candidate" | "contact",
  });

  return { action: "email_logged", entityId: match.entityId, entityType: match.entityType };
}

async function processLinkedInMessage(supabase: any, event: any, receivedAt: string, logger: any) {
  const messageData = event.data || event.message || event;
  const senderId = messageData.sender_id || messageData.provider_id || messageData.from?.provider_id;
  const messageBody = messageData.text || messageData.body || "";
  const externalMessageId = messageData.id || messageData.message_id;
  const externalConversationId = messageData.conversation_id || messageData.chat_id;

  // Detect Recruiter InMail vs Classic DM via the canonical Unipile v2
  // signals on the chat object (per unipile-node-sdk types):
  //   chat.content_type === 'inmail'                  → InMail
  //   chat.folder includes 'INBOX_LINKEDIN_RECRUITER' → InMail
  // Don't fall back to subject (Classic DMs can have subjects, InMails
  // sometimes don't surface one in the webhook). Don't fall back to
  // integration_account.account_type either: a Recruiter seat handles
  // BOTH InMails AND Classic DMs.
  const chat = messageData.chat ?? {};
  const contentType = String(
    messageData.content_type ?? chat.content_type ?? "",
  ).toLowerCase();
  const folders: string[] = []
    .concat(messageData.folder ?? [])
    .concat(chat.folder ?? [])
    .map((f: any) => String(f).toUpperCase());

  const isInMail =
    contentType === "inmail" ||
    folders.includes("INBOX_LINKEDIN_RECRUITER");

  const rawChannel = isInMail ? "linkedin_recruiter" : "linkedin";
  const channel = canonicalChannel(rawChannel);

  if (!senderId) {
    logger.info("No sender ID in message event");
    return { action: "skipped", reason: "no_sender_id" };
  }

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

  let entityId: string | null = null;
  let entityType: "candidate" | "contact" = "candidate";
  let entityColumn: "candidate_id" | "contact_id" = "candidate_id";

  const { data: candMatch } = await supabase
    .from("people")
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

  if (!entityId) {
    logger.info("No matching entity for LinkedIn sender, creating unlinked conversation", { senderId });

    const senderName = messageData.sender_name || messageData.from?.name || messageData.from?.display_name || null;
    const senderAddress = messageData.sender_address || messageData.from?.identifier || messageData.from?.profile_url || senderId;

    const conversationId = externalConversationId || `li_unknown_${senderId}`;
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
      channel,
      content_type: contentType || null,
      external_conversation_id: externalConversationId,
      last_message_at: receivedAt,
    } as any);
  }

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

  const table = entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: "linkedin",
    } as any)
    .eq("id", entityId);

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
        supabase,
        entityId,
        entityType as "candidate" | "contact",
        intel,
        "linkedin",
        enrollment?.id,
      );
    }
  }

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

  await generateJoeSays.trigger({
    entityId,
    entityType: entityType as "candidate" | "contact",
  });

  return { action: "logged", entityId, entityType, type: "linkedin_message" };
}

async function processConnectionUpdate(supabase: any, event: any, receivedAt: string, logger: any) {
  const connectionData = event.data || event.connection || event;
  const providerId = connectionData.provider_id || connectionData.attendee_provider_id;
  const status = connectionData.status || connectionData.state || "";

  if (!providerId) {
    return { action: "skipped", reason: "no_provider_id" };
  }

  let entityId: string | null = null;
  let entityType: "candidate" | "contact" = "candidate";
  let entityColumn: "candidate_id" | "contact_id" = "candidate_id";

  const { data: candMatch } = await supabase
    .from("people")
    .select("id")
    .eq("unipile_id", providerId)
    .maybeSingle();

  if (candMatch) {
    entityId = candMatch.id;
  } else {
    const { data: contactMatch } = await supabase
      .from("contacts")
      .select("id")
      .eq("unipile_id", providerId)
      .maybeSingle();

    if (contactMatch) {
      entityId = contactMatch.id;
      entityType = "contact";
      entityColumn = "contact_id";
    }
  }

  if (!entityId) {
    const { data: channelMatch } = await supabase
      .from("candidate_channels")
      .select("candidate_id")
      .or(`provider_id.eq.${providerId},unipile_id.eq.${providerId}`)
      .eq("channel", "linkedin")
      .limit(1)
      .maybeSingle();

    if (channelMatch) {
      entityId = channelMatch.candidate_id;
    } else {
      const { data: contactChannelMatch } = await supabase
        .from("contact_channels")
        .select("contact_id")
        .or(`provider_id.eq.${providerId},unipile_id.eq.${providerId}`)
        .eq("channel", "linkedin")
        .maybeSingle();

      if (contactChannelMatch) {
        entityId = contactChannelMatch.contact_id;
        entityType = "contact";
        entityColumn = "contact_id";
      }
    }
  }

  if (!entityId) {
    return { action: "no_match", providerId };
  }

  if (status === "ACCEPTED" || status === "accepted" || status === "connected") {
    if (entityType === "candidate") {
      await supabase
        .from("candidate_channels")
        .upsert({
          candidate_id: entityId,
          channel: "linkedin",
          provider_id: providerId,
          is_connected: true,
          connected_at: receivedAt,
        } as any, { onConflict: "candidate_id,channel" });
    } else {
      await supabase
        .from("contact_channels")
        .update({ is_connected: true, connected_at: receivedAt } as any)
        .eq("contact_id", entityId)
        .eq("channel", "linkedin");
    }

    await advanceOnConnectionAccepted(supabase, entityColumn, entityId, receivedAt, logger);

    await supabase.from("messages").insert({
      conversation_id: `li_${entityId}`,
      [entityColumn]: entityId,
      channel: "linkedin",
      direction: "inbound",
      body: "Connection request accepted",
      message_type: "connection_accepted",
      sent_at: receivedAt,
      provider: "unipile",
    } as any);

    logger.info("Connection accepted", { entityId, entityType });
    return { action: "connection_accepted", entityId, entityType };
  }

  return { action: "connection_update", status, entityId, entityType };
}

async function advanceOnConnectionAccepted(
  supabase: any,
  entityColumn: string,
  entityId: string,
  receivedAt: string,
  logger: any,
): Promise<void> {
  const { data: enrollments } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences!inner(*)")
    .eq(entityColumn, entityId)
    .eq("status", "active");

  if (!enrollments || enrollments.length === 0) return;

  for (const enrollment of enrollments) {
    const sequence = enrollment.sequences;
    const senderUserId = sequence.sender_user_id || sequence.created_by;

    const { data: pendingLogs } = await supabase
      .from("sequence_step_logs")
      .select("*, sequence_actions!inner(*)")
      .eq("enrollment_id", enrollment.id)
      .eq("status", "pending_connection");

    if (!pendingLogs || pendingLogs.length === 0) continue;

    for (const log of pendingLogs) {
      const action = (log as any).sequence_actions;

      const scheduledAt = await calculatePostConnectionSendTime(
        supabase,
        new Date(receivedAt),
        Number(action.base_delay_hours) || 0,
        action.delay_interval_minutes || 0,
        action.jiggle_minutes || 0,
        sequence.send_window_start || "09:00",
        sequence.send_window_end || "18:00",
        senderUserId,
      );

      await supabase
        .from("sequence_step_logs")
        .update({ scheduled_at: scheduledAt.toISOString(), status: "scheduled" })
        .eq("id", log.id);
    }

    logger.info("Connection accepted — scheduled pending linkedin messages", {
      enrollmentId: enrollment.id,
      count: pendingLogs.length,
    });
  }
}

