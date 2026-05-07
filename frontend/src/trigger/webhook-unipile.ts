import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";
import { generateJoeSays } from "./generate-joe-says";
import { extractMessageIntel, applyExtractedIntel } from "./lib/intel-extraction";
import { stopEnrollment } from "./sequence-scheduler";
import { calculatePostConnectionSendTime } from "./lib/send-time-calculator";
import { canonicalChannel } from "./lib/unipile-v2";

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

    // Phase 3: email events (Unipile Outlook). Runs in PARALLEL with the
    // Graph webhook for the same mailbox until we're confident — dedup
    // happens on insert via the messages.external_message_id unique
    // constraint, so the second arrival is a no-op.
    const isEmailEvent =
      /^mail\.|^email\.|^message\.received|outlook|gmail/i.test(eventType)
      || event.data?.account_type === "OUTLOOK"
      || event.data?.account_type === "GMAIL"
      || event.data?.attachments !== undefined && event.data?.subject !== undefined;
    if (isEmailEvent) {
      return await processUnipileEmailEvent(supabase, event, payload.receivedAt);
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL EVENT — Unipile Outlook
//
// Mirrors webhook-microsoft.ts:processEmailMessage but reads the Unipile
// event shape instead of the Graph subscription notification. Runs in
// parallel with Graph until Phase 3 cutover; messages.external_message_id
// has a unique constraint so the second-arriving copy of the same email
// is a silent no-op.
//
// Email-bounce / NDR detection: re-uses the same heuristics as
// webhook-microsoft (postmaster sender or "undeliverable" subject) and
// sets people.email_invalid + stops active enrollments. Sentiment
// extraction runs on every inbound for the universal-stop rule.
// ─────────────────────────────────────────────────────────────────────────────

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

async function processUnipileEmailEvent(supabase: any, event: any, receivedAt: string) {
  const data = event.data || event.email || event;

  // Defensive field reads — Unipile has shifted shapes between
  // accounts and even between event types within v2.
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

  // ── Hard-bounce / NDR ──────────────────────────────────────────
  const isBounce =
    EMAIL_BOUNCE_SENDER_RE.test(senderEmail) || EMAIL_BOUNCE_SUBJECT_RE.test(subject);
  if (isBounce) {
    const failed = extractFailedRecipient(bodyForSearch);
    if (failed) {
      const [{ data: cand }, { data: cont }] = await Promise.all([
        supabase.from("people").select("id").eq("email", failed).maybeSingle(),
        supabase.from("contacts").select("id").eq("email", failed).maybeSingle(),
      ]);
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

  // ── Match sender to candidate or contact ──────────────────────
  const [{ data: cand }, { data: cont }] = await Promise.all([
    supabase.from("people").select("id, full_name").eq("email", senderEmail).limit(1).maybeSingle(),
    supabase.from("contacts").select("id, full_name").eq("email", senderEmail).limit(1).maybeSingle(),
  ]);
  const match = cand
    ? { entityId: cand.id, entityType: "candidate", entityColumn: "candidate_id" as const }
    : cont
      ? { entityId: cont.id, entityType: "contact", entityColumn: "contact_id" as const }
      : null;
  if (!match) {
    logger.info("Unipile email: no entity match", { senderEmail });
    return { action: "no_match", senderEmail };
  }

  // ── Insert message (dedup on external_message_id unique constraint) ──
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
  // Unique-violation = duplicate of the Graph copy; fine, swallow.
  if (insertErr && !/duplicate key|23505/.test(insertErr.message)) {
    logger.warn("Unipile email insert failed", { error: insertErr.message });
  }

  // ── Update entity timestamps ──────────────────────────────────
  const table = match.entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({ last_responded_at: receivedAt, last_comm_channel: "email" } as any)
    .eq("id", match.entityId);

  // ── Sentiment + universal stop rule ───────────────────────────
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
      supabase, match.entityId, match.entityType as "candidate" | "contact",
      intel, "email", enrollment?.id,
    );

    // Stop ALL active enrollments for this person on any reply.
    const { data: actives } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");
    for (const e of actives ?? []) {
      await stopEnrollment(supabase, e, "reply_received", bodyForSearch.slice(0, 500));
    }
  }

  // Refresh Joe Says
  await generateJoeSays.trigger({
    entityId: match.entityId,
    entityType: match.entityType as "candidate" | "contact",
  });

  return { action: "email_logged", entityId: match.entityId, entityType: match.entityType };
}

async function processLinkedInMessage(supabase: any, event: any, receivedAt: string) {
  const messageData = event.data || event.message || event;
  const senderId = messageData.sender_id || messageData.provider_id || messageData.from?.provider_id;
  const messageBody = messageData.text || messageData.body || "";
  const externalMessageId = messageData.id || messageData.message_id;
  const externalConversationId = messageData.conversation_id || messageData.chat_id;

  // Detect LinkedIn variant (Classic vs Recruiter InMail).
  //
  // Recruiters use a single Unipile account that handles BOTH their
  // Classic LinkedIn DMs AND their Recruiter InMails — so we can't
  // route based on account_type alone or every Chris message ends up
  // in the Recruiter tab. Look at per-message signals first; only use
  // account_type as a last resort, and only for Sales Nav.
  //
  // InMail signals (any one wins):
  //   - message_type === "INMAIL"
  //   - is_inmail === true
  //   - content_type === "inmail"
  //   - folder includes "INBOX_LINKEDIN_RECRUITER" or "INMAIL"
  //   - provider_type includes "recruiter"
  //   - chat has a subject (Classic DMs are subject-less, InMails have one)
  const folderField = String(
    messageData.folder ?? messageData.chat?.folder ?? "",
  ).toUpperCase();
  const providerType = String(
    messageData.provider_type ??
    messageData.chat?.provider_type ??
    messageData.account_type ??
    event.account_type ??
    "",
  ).toLowerCase();
  const messageType = String(
    messageData.message_type ?? messageData.type ?? "",
  ).toUpperCase();
  const contentType = String(
    messageData.content_type ?? messageData.chat?.content_type ?? "",
  ).toLowerCase();
  const chatSubject = String(messageData.chat?.subject ?? messageData.subject ?? "").trim();

  const isInMail =
    messageType === "INMAIL" ||
    messageData.is_inmail === true ||
    contentType === "inmail" ||
    folderField.includes("INMAIL") ||
    folderField.includes("LINKEDIN_RECRUITER") ||
    providerType.includes("recruiter") ||
    !!chatSubject;

  let rawChannel = isInMail
    ? "linkedin_recruiter"
    : providerType.includes("sales") || folderField.includes("SALES_NAV")
      ? "linkedin_sales_nav"
      : "linkedin";

  // Sales Nav can still fall through to account_type since it's a
  // dedicated account product, not a feature that overlaps Classic.
  if (rawChannel === "linkedin") {
    const eventAccountId = messageData.account_id ?? event.account_id ?? messageData.chat?.account_id;
    if (eventAccountId) {
      const { data: ia } = await supabase
        .from("integration_accounts")
        .select("account_type")
        .eq("unipile_account_id", eventAccountId)
        .maybeSingle();
      if (ia?.account_type === "sales_navigator") rawChannel = "linkedin_sales_nav";
    }
  }
  // Collapse to the 3-bucket model used everywhere else (linkedin /
  // linkedin_recruiter / sms / email). Sales Nav messages join the
  // generic linkedin bucket.
  const channel = canonicalChannel(rawChannel);

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
  // Primary lookup — candidate_channels is used as fallback in connection handler.
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

  // Handle unknown sender — create unlinked conversation and message
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

  // Determine or create conversation
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

  // Match entity using same approach as processLinkedInMessage:
  // 1. Check candidates.unipile_id (primary match)
  // 2. Check contacts.unipile_id
  // 3. Fall back to candidate_channels/contact_channels (legacy)
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

  // Fallback: check candidate_channels / contact_channels (legacy lookup)
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
    // Update candidate_channels if this is a candidate
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

    // V2: Advance any enrollments waiting for connection acceptance
    await advanceOnConnectionAccepted(supabase, entityColumn, entityId, receivedAt);

    // Log connection_accepted as a special message type
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

// ─────────────────────────────────────────────────────────────────────────────
// V2 Sequence: Schedule pending_connection actions on connection accepted
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
    const sequence = enrollment.sequences;
    const senderUserId = sequence.sender_user_id || sequence.created_by;

    // Find all pending_connection step logs for this enrollment
    const { data: pendingLogs } = await supabase
      .from("sequence_step_logs")
      .select("*, sequence_actions!inner(*)")
      .eq("enrollment_id", enrollment.id)
      .eq("status", "pending_connection");

    if (!pendingLogs || pendingLogs.length === 0) continue;

    for (const log of pendingLogs) {
      const action = (log as any).sequence_actions;

      // Calculate: 4h minimum + additional delay, using business-hours model
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

      // Activate the step log
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
