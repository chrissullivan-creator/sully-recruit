import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  extractMessageIntel,
  applyExtractedIntel,
} from "../../../../src/server-lib/intel-extraction.js";
import { stopEnrollment, rescheduleEnrollmentForOOO } from "../../../../src/server-lib/sequence-runner.js";
import {
  detectOutOfOfficeHeuristic,
  decideOutOfOffice,
  noteOutOfOffice,
  clearOutOfOffice,
} from "../../../../src/server-lib/out-of-office.js";
import { calculatePostConnectionSendTime } from "../../../../src/server-lib/send-time-calculator.js";
import { canonicalChannel } from "../../../../src/server-lib/unipile-v2.js";
import { matchPersonByEmail } from "../../../../src/server-lib/match-person-by-email.js";
import { updateLinkedinAccountStatus } from "../../../lib/unipile-linkedin.js";
import { resolvePerson, type LinkMethod } from "../../identity-resolver.js";
import { autoCreatePersonFromOutbound } from "../../../../src/server-lib/resolve-counterparty.js";

/**
 * Process Unipile webhook events (LinkedIn messages, connection updates,
 * Outlook email via the Phase-3 parallel feed). Matches by provider_id /
 * email, logs to messages + conversations, runs Joe sentiment-and-intel
 * extraction on inbound, stops active enrollments on any reply, and
 * fires `ai/joe-says.requested` to keep the brief current.
 *
 * Envelope: Unipile v2 wraps payloads as:
 *   { object: "Event", type: "<dotted.path>", account_id, account_name,
 *     account_provider: "outlook"|"linkedin"|...,  payload: { ... } }
 * The inner handlers below unwrap `payload` first (v2) and fall back to
 * `data`/`message`/`connection`/the whole event (v1 / older webhooks)
 * so we stay backwards-compatible with anything Unipile-side that
 * hasn't migrated.
 *
 * Non-actionable event types — folder counters, account state pings,
 * profile views — get filtered upfront so we don't waste a function
 * invocation pretending they're a message.
 */
interface UnipileWebhookPayload {
  body: {
    // v2 envelope
    object?: string;
    type?: string;
    account_id?: string;
    account_name?: string;
    account_provider?: string;
    payload?: any;
    AccountStatus?: any;
    // v1 / legacy fallbacks
    event?: string;
    data?: any;
    message?: any;
    conversation?: any;
    connection?: any;
  };
  receivedAt: string;
  verified?: boolean;
}

type LinkedinEntityMatch = {
  entityId: string;
  entityType: "candidate" | "contact";
  entityColumn: "candidate_id" | "contact_id";
  linkMethod: LinkMethod;
};

// v2 event types we deliberately ignore — they fire frequently and
// don't represent inbound communication we need to log.
const IGNORED_V2_TYPES = /^(email\.folder\.|email\.account\.|account\.|users\.profile\.|message\.read|chat\.read)/i;

function getLinkedinSenderProviderId(messageData: any): string | null {
  return messageData.sender_id
    || messageData.sender?.attendee_provider_id
    || messageData.sender?.provider_id
    || messageData.provider_id
    || messageData.from?.provider_id
    || null;
}

function getLinkedinSenderProfileUrl(messageData: any): string | null {
  return messageData.sender?.attendee_profile_url
    || messageData.sender?.profile_url
    || messageData.from?.profile_url
    || null;
}

function classifyLinkedinChannel(messageData: any) {
  const contentType = String(
    messageData.content_type
      ?? messageData.chat?.content_type
      ?? "",
  ).toLowerCase();
  const folders: string[] = []
    .concat(messageData.folder ?? [])
    .concat(messageData.chat?.folder ?? [])
    .map((f: any) => String(f).toUpperCase());

  // Unipile's webhook docs expose account_info.feature, but a Recruiter seat
  // can still exchange Classic DMs. Keep content_type / folder as the source
  // of truth for bucketing InMail vs Classic traffic.
  const isInMail =
    contentType === "inmail" ||
    folders.includes("INBOX_LINKEDIN_RECRUITER");

  return {
    channel: canonicalChannel(isInMail ? "linkedin_recruiter" : "linkedin"),
    contentType,
  };
}

function detectLinkedinDirection(eventBody: any, messageData: any, senderProviderId: string | null) {
  if (messageData.is_sender === true || messageData.is_sender === 1) return "outbound" as const;

  // Per Unipile's new-messages webhook docs, sent messages are included and
  // can be detected by comparing account_info.user_id with the sender's
  // provider ID.
  const ownerProviderId =
    eventBody.account_info?.user_id
    || messageData.account_info?.user_id
    || null;

  if (ownerProviderId && senderProviderId && ownerProviderId === senderProviderId) {
    return "outbound" as const;
  }

  return "inbound" as const;
}

// Thin wrapper over the centralized identity resolver so call sites in
// this file don't need to change shape. The resolver itself lives in
// `frontend/api/lib/identity-resolver.ts` — single source of truth for
// (channel, identity) → person across messages, email, calls, calendar.
async function matchLinkedinEntity(
  supabase: any,
  providerId: string | null,
  linkedinUrl: string | null,
): Promise<LinkedinEntityMatch | null> {
  const resolved = await resolvePerson(supabase, "linkedin", {
    providerId,
    unipileId: providerId,
    linkedinUrl,
  });
  if (!resolved) return null;
  return {
    entityId: resolved.personId,
    entityType: resolved.personType,
    entityColumn: resolved.entityColumn,
    linkMethod: resolved.linkMethod,
  };
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
    const accountStatus =
      body.AccountStatus
      || body.payload?.AccountStatus
      || body.data?.AccountStatus
      || null;
    const eventType = body.type || body.event || "";
    const provider = String(body.account_provider || "").toLowerCase();

    logger.info("Processing Unipile event", {
      eventType,
      provider,
      account_id: body.account_id || accountStatus?.account_id,
    });

    if (accountStatus?.account_id && accountStatus?.message) {
      await updateLinkedinAccountStatus(
        supabase,
        accountStatus.account_id,
        accountStatus.message,
        {
          account_type: accountStatus.account_type || null,
          last_account_status_message: accountStatus.message,
        },
      );
      return {
        action: "account_status_updated",
        account_id: accountStatus.account_id,
        status: accountStatus.message,
      };
    }

    if (eventType && IGNORED_V2_TYPES.test(eventType)) {
      return { action: "skipped", reason: "non_actionable_event", type: eventType };
    }

    // Email events: provider says outlook/gmail OR the type starts with
    // mail./email. (and isn't a folder/account ping caught above).
    const isEmailEvent =
      provider === "outlook" ||
      provider === "gmail" ||
      /^mail\.|^email\.message|^message\.received/i.test(eventType) ||
      body.data?.account_type === "OUTLOOK" ||
      body.data?.account_type === "GMAIL";
    if (isEmailEvent) {
      return await processUnipileEmailEvent(supabase, body, payload.receivedAt, logger);
    }

    if (eventType.includes("message") || body.message || body.payload?.text || body.payload?.body) {
      return await processLinkedInMessage(supabase, body, payload.receivedAt, logger);
    }

    if (eventType.includes("invitation") || eventType.includes("connection") || body.connection) {
      return await processConnectionUpdate(supabase, body, payload.receivedAt, logger);
    }

    logger.info("Unhandled Unipile event type", { eventType, provider });
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
  // v2 envelope wraps the email in `payload`; legacy webhooks used
  // `data` / `email` / the event itself. Try v2 first, fall through.
  const data = event.payload || event.data || event.email || event;

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
  }

  // OOO handling mirrors the Microsoft Graph processor: an auto-reply
  // reschedules the next step (day after return) instead of stopping. See
  // process-microsoft-event.ts / out-of-office.ts for the rationale.
  const ooo = decideOutOfOffice(
    intel?.sentiment,
    intel?.ooo_return_date,
    detectOutOfOfficeHeuristic(subject, bodyForSearch),
  );
  const oooReturnDate = ooo.returnDate;

  if (ooo.isOOO) {
    if (externalId) {
      await supabase
        .from("messages")
        .update({ message_type: "auto_reply" } as any)
        .eq("external_message_id", externalId)
        .eq("direction", "inbound");
    }
    const { data: actives } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");
    let resumeAt: Date | null = null;
    for (const e of actives ?? []) {
      const r = await rescheduleEnrollmentForOOO(supabase, e, oooReturnDate, logger);
      if (r) resumeAt = r;
    }
    await noteOutOfOffice(supabase, match, oooReturnDate, resumeAt);
    logger.info("Unipile OOO auto-reply — rescheduled instead of stopping", {
      entityId: match.entityId,
      returnDate: oooReturnDate,
    });
  } else if (intel) {
    const { data: actives } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq(match.entityColumn, match.entityId)
      .eq("status", "active");
    for (const e of actives ?? []) {
      await stopEnrollment(supabase, e, "reply_received", bodyForSearch.slice(0, 500));
    }
    await clearOutOfOffice(supabase, match);
  }

  await inngest.send({
    name: "ai/joe-says.requested",
    data: {
      entityId: match.entityId,
      entityType: match.entityType as "candidate" | "contact",
    },
  });

  return { action: "email_logged", entityId: match.entityId, entityType: match.entityType };
}

async function processLinkedInMessage(supabase: any, event: any, receivedAt: string, logger: any) {
  // v2 envelope wraps the message in `payload`; older variants use
  // `data` / `message` / the event itself.
  const messageData = event.payload || event.data || event.message || event;
  const senderId = getLinkedinSenderProviderId(messageData);
  const senderProfileUrl = getLinkedinSenderProfileUrl(messageData);
  const messageBody = messageData.text || messageData.body || "";
  const unipileMessageId = messageData.id || messageData.message_id;
  const externalConversationId = messageData.conversation_id || messageData.chat_id;

  // Resolve Unipile account_id → our internal integration_accounts.id.
  // Used as part of the UNIQUE key when looking up / inserting conversations
  // so we don't re-create a duplicate row per webhook delivery.
  const unipileAccountId = event.account_id || event.payload?.account_id;
  let integrationAccountId: string | null = null;
  if (unipileAccountId) {
    const { data: ia } = await supabase
      .from("integration_accounts")
      .select("id")
      .eq("unipile_account_id", unipileAccountId)
      .maybeSingle();
    integrationAccountId = ia?.id ?? null;
  }

  const { channel, contentType } = classifyLinkedinChannel(messageData);
  const direction = detectLinkedinDirection(event, messageData, senderId);

  if (!senderId) {
    logger.info("No sender ID in message event");
    return { action: "skipped", reason: "no_sender_id" };
  }

  if (unipileMessageId) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .or(`unipile_message_id.eq.${unipileMessageId},external_message_id.eq.${unipileMessageId}`)
      .limit(1);
    if (existing && existing.length > 0) {
      return { action: "skipped", reason: "duplicate" };
    }
  }

  const entityMatch = await matchLinkedinEntity(supabase, senderId, senderProfileUrl);
  let entityId: string | null = entityMatch?.entityId ?? null;
  let entityType: "candidate" | "contact" = entityMatch?.entityType ?? "candidate";
  let entityColumn: "candidate_id" | "contact_id" = entityMatch?.entityColumn ?? "candidate_id";
  const linkMethod: LinkMethod | null = entityMatch?.linkMethod ?? null;

  // Find-or-create the conversation row. The lookup MUST match the unique
  // index (integration_account_id, channel, external_conversation_id) so
  // repeated webhook deliveries / backfill passes don't create dups.
  // Previous code looked up by `id` (UUID PK) with a Unipile chat-id string,
  // which never matched → every webhook inserted a fresh row.
  async function findOrCreateConversation(personColumn: "candidate_id" | "contact_id" | null, personId: string | null): Promise<string | null> {
    if (externalConversationId && integrationAccountId) {
      const { data: existing } = await supabase
        .from("conversations")
        .select("id")
        .eq("external_conversation_id", externalConversationId)
        .eq("integration_account_id", integrationAccountId)
        .eq("channel", channel)
        .order("created_at", { ascending: true })
        .limit(1);
      if (existing && existing.length > 0) return existing[0].id;
    }
    const row: any = {
      candidate_id: personColumn === "candidate_id" ? personId : null,
      contact_id: personColumn === "contact_id" ? personId : null,
      channel,
      content_type: contentType || null,
      external_conversation_id: externalConversationId || null,
      integration_account_id: integrationAccountId,
      last_message_at: receivedAt,
      is_read: false,
      link_method: personId && linkMethod ? `webhook:${linkMethod}` : null,
    };
    const { data: created, error } = await supabase
      .from("conversations")
      .upsert(row, {
        onConflict: "integration_account_id,channel,external_conversation_id",
        ignoreDuplicates: true,
      })
      .select("id")
      .single();
    if (error) {
      // UNIQUE-index race: another delivery created it first. Re-read.
      if (externalConversationId && integrationAccountId) {
        const { data: again } = await supabase
          .from("conversations")
          .select("id")
          .eq("external_conversation_id", externalConversationId)
          .eq("integration_account_id", integrationAccountId)
          .eq("channel", channel)
          .order("created_at", { ascending: true })
          .limit(1);
        if (again && again.length > 0) return again[0].id;
      }
      logger.error("Conversation create failed", { error: error.message });
      return null;
    }
    return created?.id ?? null;
  }

  // Auto-add: an inbound LinkedIn Recruiter (InMail) message is a real person
  // reaching out, so create the candidate now instead of dropping it (the
  // Phase-5 rule below). matchLinkedinEntity above already deduped (provider
  // id / candidate_channels / slug), so we only land here when they're
  // genuinely new; autoCreatePersonFromOutbound mirrors the provider id into
  // candidate_channels so the next message hard-matches, and the
  // resolve-unipile / find-linkedin crons backfill title/company/URL.
  // Scoped to inbound: on outbound the sender id is *us* (that's how direction
  // is detected), and outbound recipients are auto-added upstream in the send
  // path — so creating from senderId here is only correct for inbound.
  if (!entityId && channel === "linkedin_recruiter" && direction === "inbound" && integrationAccountId) {
    const { data: ownerRow } = await supabase
      .from("integration_accounts")
      .select("owner_user_id")
      .eq("id", integrationAccountId)
      .maybeSingle();
    const ownerUserId = ownerRow?.owner_user_id ?? null;
    const senderName =
      messageData.sender_name || messageData.from?.name || messageData.from?.display_name || null;
    if (ownerUserId) {
      const created = await autoCreatePersonFromOutbound(supabase, {
        channel: "linkedin_recruiter",
        address: senderId,
        name: senderName,
        ownerUserId,
        source: "recruiter_inmail",
      });
      if (created) {
        entityId = created.id;
        entityType = created.type;
        entityColumn = created.entityColumn;
        logger.info("Auto-created candidate from inbound LinkedIn Recruiter InMail", {
          senderId,
          personId: entityId,
        });
      }
    }
  }

  if (!entityId) {
    // Phase 5 rule: inbound from unknown LinkedIn senders is NOT persisted.
    // The live inbox UI will fetch the last 100 LinkedIn messages from
    // Unipile directly for the "Other" view; once the user adds the
    // person, the person.created webhook backfills the history.
    // Outbound from us to a non-CRM recipient still persists (it's our
    // work product) — auto-add of the recipient happens upstream in the
    // send path.
    if (direction === "inbound") {
      logger.info("Dropping inbound LinkedIn from unknown sender (Phase 5 rule)", {
        senderId,
        external_message_id: unipileMessageId,
      });
      return {
        action: "dropped",
        reason: "unknown_sender_inbound",
        senderId,
        type: "linkedin_message",
      };
    }

    logger.info("Outbound LinkedIn to non-CRM recipient — persisting as unlinked", { senderId });

    const senderName = messageData.sender_name || messageData.from?.name || messageData.from?.display_name || null;
    const senderAddress =
      messageData.sender_address
      || messageData.sender?.attendee_profile_url
      || messageData.from?.identifier
      || messageData.from?.profile_url
      || senderId;

    const conversationId = await findOrCreateConversation(null, null);
    if (!conversationId) {
      return { action: "skipped", reason: "conversation_create_failed", type: "linkedin_message" };
    }

    const { error: unlinkedInsertErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      candidate_id: null,
      contact_id: null,
      integration_account_id: integrationAccountId,
      channel,
      direction,
      body: messageBody,
      sent_at: messageData.created_at || receivedAt,
      received_at: direction === "inbound" ? (messageData.created_at || receivedAt) : null,
      provider: "unipile",
      external_message_id: unipileMessageId,
      external_conversation_id: externalConversationId,
      unipile_message_id: unipileMessageId,
      unipile_chat_id: externalConversationId,
      sender_name: senderName,
      sender_address: senderAddress,
      raw_payload: messageData,
      is_read: direction === "outbound",
      needs_link: true,
      link_attempted_at: new Date().toISOString(),
    } as any);
    // Idempotency backstop: the partial UNIQUE index on
    // (provider, external_message_id) fires 23505 on re-delivery races
    // that slipped past the pre-insert check above.
    if (unlinkedInsertErr && (unlinkedInsertErr as any).code === "23505") {
      return { action: "skipped", reason: "duplicate_unique_violation", type: "linkedin_message" };
    }

    const conversationUpdate: Record<string, any> = {
      last_message_at: receivedAt,
      last_message_preview: messageBody.substring(0, 100),
    };
    if (direction === "inbound") conversationUpdate.is_read = false;

    await supabase
      .from("conversations")
      .update(conversationUpdate)
      .eq("id", conversationId);

    return { action: "logged_unlinked", senderId, senderName, direction, type: "linkedin_message" };
  }

  const conversationId = await findOrCreateConversation(entityColumn, entityId);
  if (!conversationId) {
    return { action: "skipped", reason: "conversation_create_failed", type: "linkedin_message" };
  }

  const { error: linkedInsertErr } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    [entityColumn]: entityId,
    integration_account_id: integrationAccountId,
    channel,
    direction,
    body: messageBody,
    sent_at: messageData.created_at || receivedAt,
    received_at: direction === "inbound" ? (messageData.created_at || receivedAt) : null,
    provider: "unipile",
    external_message_id: unipileMessageId,
    external_conversation_id: externalConversationId,
    unipile_message_id: unipileMessageId,
    unipile_chat_id: externalConversationId,
    sender_name: messageData.sender?.attendee_name || messageData.sender_name || null,
    sender_address: senderProfileUrl || senderId,
    raw_payload: messageData,
    is_read: direction === "outbound",
    needs_link: false,
    link_method: linkMethod ? `webhook:${linkMethod}` : null,
    link_attempted_at: new Date().toISOString(),
  } as any);
  // Idempotency backstop — see comment on the unlinked-path insert above.
  if (linkedInsertErr && (linkedInsertErr as any).code === "23505") {
    return { action: "skipped", reason: "duplicate_unique_violation", entityId, channel, direction, type: "linkedin_message" };
  }

  const conversationUpdate: Record<string, any> = {
    last_message_at: receivedAt,
    last_message_preview: messageBody.substring(0, 100),
    // Auto-derive status: inbound = replied, outbound = awaiting_reply.
    // Clears any prior snooze status now that there's fresh activity.
    status: direction === "inbound" ? "replied" : "awaiting_reply",
  };
  if (direction === "inbound") conversationUpdate.is_read = false;

  await supabase
    .from("conversations")
    .update(conversationUpdate)
    .eq("id", conversationId);

  const table = entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: channel,
    } as any)
    .eq("id", entityId);

  if (direction === "inbound" && messageBody.length > 10) {
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
        channel,
        enrollment?.id,
      );
    }
  }

  if (direction === "inbound") {
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
  }

  logger.info("LinkedIn message logged", { entityId, entityType, channel, direction });

  await inngest.send({
    name: "ai/joe-says.requested",
    data: {
      entityId,
      entityType: entityType as "candidate" | "contact",
    },
  });

  return { action: "logged", entityId, entityType, channel, direction, type: "linkedin_message" };
}

async function processConnectionUpdate(supabase: any, event: any, receivedAt: string, logger: any) {
  // v2 envelope wraps the connection update in `payload`; older
  // variants use `data` / `connection` / the event itself.
  const connectionData = event.payload || event.data || event.connection || event;
  const providerId =
    connectionData.provider_id
    || connectionData.attendee_provider_id
    || connectionData.sender?.attendee_provider_id;
  const status = connectionData.status || connectionData.state || "";

  if (!providerId) {
    return { action: "skipped", reason: "no_provider_id" };
  }

  const entityMatch = await matchLinkedinEntity(
    supabase,
    providerId,
    connectionData.profile_url || connectionData.public_profile_url || null,
  );
  const entityId: string | null = entityMatch?.entityId ?? null;
  const entityType: "candidate" | "contact" = entityMatch?.entityType ?? "candidate";
  const entityColumn: "candidate_id" | "contact_id" = entityMatch?.entityColumn ?? "candidate_id";

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
        sequence.timezone || undefined,
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
