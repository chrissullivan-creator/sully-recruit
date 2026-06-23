import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UNIPILE_WEBHOOK_SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CHICAGO_TZ = "America/Chicago";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-unipile-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const INBOUND_MESSAGE_EVENTS = new Set(["message.new","messaging.message","linkedin.message"]);
const CONNECTION_EVENTS = new Set(["connection.accepted","linkedin.connection.accepted","relation.new"]);
const IGNORE_EVENTS = new Set(["message.reaction","message.read","message.edit","message.delete","message.delivered"]);
const CONNECTION_STEP_TYPES = ["connection_request","send_connection","linkedin_connection"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function randomInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/** Constant-time string compare so the shared secret can't be recovered via timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Strip HTML tags and decode common entities.
 */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Try every known field path that Unipile uses for message text across
 * LinkedIn Classic, Recruiter, and Sales Nav message types.
 * Returns empty string if genuinely no text exists.
 */
function extractMessageText(data: Record<string, unknown>): string {
  const raw =
    data.text ??
    data.body ??
    data.content ??
    data.message ??
    data.message_text ??
    data.body_html ??
    data.rendered_body ??
    data.text_html ??
    data.inmail_body ??
    data.inmail_text ??
    // nested sender object sometimes carries the message
    (data.message as Record<string, unknown>)?.text ??
    (data.message as Record<string, unknown>)?.body ??
    null;

  if (!raw) return "";
  const str = String(raw).trim();
  if (!str) return "";
  // Strip HTML if the content looks like HTML
  return str.startsWith("<") ? stripHtml(str) : str;
}

function enforceWindow(date: Date): Date {
  const WINDOW_START = 4 * 60 + 30;
  const WINDOW_END = 21 * 60 + 30;
  let d = new Date(date.getTime());
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(d).map((p) => [p.type, p.value])
    );
    const total = Number(parts.hour === "24" ? 0 : parts.hour) * 60 + Number(parts.minute);
    if (total >= WINDOW_START && total < WINDOW_END) return d;
    d = total < WINDOW_START
      ? new Date(d.getTime() + (WINDOW_START - total) * 60000)
      : new Date(d.getTime() + (24 * 60 - total + WINDOW_START) * 60000);
  }
  return d;
}

async function getIntegrationByUnipileId(unipileAccountId: string) {
  const { data } = await supabase.from("integration_accounts")
    .select("id, owner_user_id, account_label, unipile_provider")
    .eq("unipile_account_id", unipileAccountId).eq("is_active", true).maybeSingle();
  return data;
}

async function findCandidate(unipileId: string | null, linkedinUrl: string | null) {
  if (unipileId) {
    const { data } = await supabase.from("candidates").select("id, full_name, unipile_id").eq("unipile_id", unipileId).maybeSingle();
    if (data) return { ...data, table: "candidates" };
  }
  if (linkedinUrl) {
    const slug = linkedinUrl.replace(/\/+$/, "").split("/in/")[1];
    if (slug && !slug.startsWith("ACo") && !slug.startsWith("acw")) {
      const { data } = await supabase.from("candidates").select("id, full_name, unipile_id").ilike("linkedin_url", `%${slug}%`).maybeSingle();
      if (data) return { ...data, table: "candidates" };
    }
  }
  return null;
}

async function findContact(unipileId: string | null, linkedinUrl: string | null) {
  if (unipileId) {
    const { data } = await supabase.from("contacts").select("id, full_name, unipile_id").eq("unipile_id", unipileId).maybeSingle();
    if (data) return { ...data, table: "contacts" };
  }
  if (linkedinUrl) {
    const slug = linkedinUrl.replace(/\/+$/, "").split("/in/")[1];
    if (slug && !slug.startsWith("ACo") && !slug.startsWith("acw")) {
      const { data } = await supabase.from("contacts").select("id, full_name, unipile_id").ilike("linkedin_url", `%${slug}%`).maybeSingle();
      if (data) return { ...data, table: "contacts" };
    }
  }
  return null;
}

async function stampUnipileId(table: string, id: string, unipileId: string) {
  await supabase.from(table).update({ unipile_id: unipileId, updated_at: new Date().toISOString() }).eq("id", id);
}

async function upsertConversation(params: {
  chatId: string | null; candidateId: string | null; contactId: string | null;
  channel: string; integrationAccountId: string | null; assignedUserId: string | null;
}): Promise<string> {
  const now = new Date().toISOString();
  if (params.chatId) {
    const { data: existing } = await supabase.from("conversations").select("id")
      .or(`external_conversation_id.eq.${params.chatId},account_id.eq.${params.chatId}`).maybeSingle();
    if (existing) return existing.id;
  }
  const { data: created, error } = await supabase.from("conversations").insert({
    candidate_id: params.candidateId, contact_id: params.contactId, channel: params.channel,
    integration_account_id: params.integrationAccountId, external_conversation_id: params.chatId ?? null,
    is_read: false, is_archived: false, assigned_user_id: params.assignedUserId,
    last_message_at: now, created_at: now, updated_at: now,
  }).select("id").single();
  if (error || !created) {
    if (params.candidateId) {
      const { data: fb } = await supabase.from("conversations").select("id").eq("candidate_id", params.candidateId).eq("channel", params.channel).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (fb) return fb.id;
    }
    if (params.contactId) {
      const { data: fb } = await supabase.from("conversations").select("id").eq("contact_id", params.contactId).eq("channel", params.channel).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (fb) return fb.id;
    }
    throw new Error(`Could not create or find conversation: ${error?.message}`);
  }
  return created.id;
}

async function analyzeSentiment(messageText: string, channel: string): Promise<{ sentiment: string; summary: string } | null> {
  if (!ANTHROPIC_API_KEY || !messageText.trim()) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `You analyze inbound replies to recruiting outreach from a Wall Street recruiting firm specializing in hedge funds, investment banks, prop trading, fintech, and asset managers. Your job is to classify the sentiment of the reply and write a crisp, useful 1-2 sentence note for the recruiter to read when reviewing the candidate or contact profile.

Respond ONLY with valid JSON — no preamble, no markdown fences:
{"sentiment": "...", "summary": "..."}

Sentiment must be exactly one of:
- interested: actively asking about a role, requesting details, wants to talk
- positive: friendly and responsive but no explicit role interest
- maybe: open to hearing more but noncommittal
- neutral: purely transactional, no signal either way
- negative: dismissive or unfriendly but not asking to stop
- not_interested: clearly declining, too busy, happy where they are
- do_not_contact: explicitly asked to stop reaching out, unsubscribe, or remove from list

Keep the summary factual, recruiter-facing, and scannable. No fluff.`,
        messages: [{
          role: "user",
          content: `Channel: ${channel}\n\nInbound message:\n${messageText.slice(0, 1500)}`
        }]
      })
    });
    if (!resp.ok) {
      console.error("[sentiment] Anthropic API error:", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const data = await resp.json();
    const text = (data.content?.[0]?.text ?? "") as string;
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (!parsed.sentiment || !parsed.summary) return null;
    return { sentiment: parsed.sentiment, summary: parsed.summary };
  } catch (e) {
    console.error("[sentiment] analysis failed:", e);
    return null;
  }
}

async function saveSentiment(params: {
  candidateId: string | null; contactId: string | null; enrollmentId: string | null;
  channel: string; sentiment: string; summary: string; rawMessage: string;
}) {
  const now = new Date().toISOString();
  await supabase.from("reply_sentiment").insert({
    candidate_id: params.candidateId, contact_id: params.contactId,
    enrollment_id: params.enrollmentId, channel: params.channel,
    sentiment: params.sentiment, summary: params.summary,
    raw_message: params.rawMessage.slice(0, 2000),
    analyzed_at: now, created_at: now,
  });
}

async function handleReplyStop(candidateId: string | null, contactId: string | null) {
  const col = candidateId ? "candidate_id" : "contact_id";
  const val = candidateId ?? contactId;
  if (!val) return;
  const { data: enrollments } = await supabase.from("sequence_enrollments")
    .select("id, sequence_id").eq(col, val).eq("status", "active");
  for (const e of enrollments ?? []) {
    const { data: seq } = await supabase.from("sequences").select("stop_on_reply").eq("id", e.sequence_id).maybeSingle();
    if (seq?.stop_on_reply !== false) {
      await supabase.from("sequence_enrollments").update({
        status: "stopped", stopped_reason: "reply_received_linkedin", updated_at: new Date().toISOString(),
      }).eq("id", e.id);
      console.log(`[reply-stop] stopped enrollment ${e.id}`);
    }
  }
}

async function handleConnectionAccepted(candidateId: string | null, contactId: string | null) {
  const col = candidateId ? "candidate_id" : "contact_id";
  const val = candidateId ?? contactId;
  if (!val) return;

  const { data: enrollments } = await supabase.from("sequence_enrollments")
    .select("id, sequence_id, current_step_order")
    .eq(col, val)
    .eq("status", "active")
    .or("waiting_for_connection_acceptance.eq.true,linkedin_connection_status.eq.requested");

  if (!enrollments?.length) {
    console.log(`[connection-accepted] no matching enrollments for ${val}`);
    return;
  }

  const now = new Date();

  for (const enrollment of enrollments) {
    const { data: currentStep } = await supabase.from("sequence_steps").select("*")
      .eq("sequence_id", enrollment.sequence_id)
      .eq("step_order", enrollment.current_step_order)
      .eq("is_active", true).maybeSingle();

    const { data: nextStep } = await supabase.from("sequence_steps").select("*")
      .eq("sequence_id", enrollment.sequence_id).eq("is_active", true)
      .gt("step_order", enrollment.current_step_order)
      .order("step_order", { ascending: true }).limit(1).maybeSingle();

    if (!nextStep) {
      await supabase.from("sequence_enrollments").update({
        status: "completed", completed_at: now.toISOString(),
        linkedin_connection_accepted_at: now.toISOString(),
        linkedin_connection_status: "accepted",
        waiting_for_connection_acceptance: false,
        next_step_at: null, updated_at: now.toISOString(),
      }).eq("id", enrollment.id);
      continue;
    }

    const delayHours = (currentStep as Record<string, unknown>)?.post_connect_delay_hours ?? 4;
    const jMin = Number((currentStep as Record<string, unknown>)?.post_connect_jitter_min ?? 2);
    const jMax = Number((currentStep as Record<string, unknown>)?.post_connect_jitter_max ?? 35);
    const jitterMs = randomInt(jMin, jMax) * 60000;
    const rawTime = new Date(now.getTime() + Number(delayHours) * 3600000 + jitterMs);
    const nextIsConn = CONNECTION_STEP_TYPES.includes(((nextStep as Record<string, unknown>).step_type as string ?? "").toLowerCase());
    const nextAt = nextIsConn ? rawTime : enforceWindow(rawTime);

    await supabase.from("sequence_enrollments").update({
      current_step_order: (nextStep as Record<string, unknown>).step_order,
      next_step_at: nextAt.toISOString(),
      linkedin_connection_accepted_at: now.toISOString(),
      linkedin_connection_status: "accepted",
      waiting_for_connection_acceptance: false,
      staggered_at: null, updated_at: now.toISOString(),
    }).eq("id", enrollment.id);
  }
}

async function findActiveEnrollment(candidateId: string | null, contactId: string | null): Promise<string | null> {
  const col = candidateId ? "candidate_id" : "contact_id";
  const val = candidateId ?? contactId;
  if (!val) return null;
  const { data } = await supabase.from("sequence_enrollments")
    .select("id").eq(col, val).eq("status", "active")
    .order("enrolled_at", { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Verify the request really came from Unipile. Fail CLOSED: a missing secret
  // is a misconfiguration, not a license to accept anonymous events. The old
  // `if (UNIPILE_WEBHOOK_SECRET)` guard silently accepted EVERY request whenever
  // the env var was unset/empty — any caller could then inject forged inbound
  // LinkedIn messages / connection-accepts (driving stop-on-reply, sentiment,
  // fake inbox entries). Set UNIPILE_WEBHOOK_STRICT=false only to temporarily
  // log-and-accept during a secret rotation.
  const strict = (Deno.env.get("UNIPILE_WEBHOOK_STRICT") ?? "true").toLowerCase() !== "false";
  if (strict) {
    if (!UNIPILE_WEBHOOK_SECRET) {
      console.error("[unipile-webhook] UNIPILE_WEBHOOK_SECRET not set — refusing (set UNIPILE_WEBHOOK_STRICT=false to bypass during rotation)");
      return json({ error: "Webhook secret not configured" }, 500);
    }
    const sig = req.headers.get("x-unipile-signature") ?? "";
    if (!timingSafeEqualStr(sig, UNIPILE_WEBHOOK_SECRET)) return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const event = String(body.event ?? body.type ?? "").toLowerCase();
  const data = (body.data ?? body) as Record<string, unknown>;
  const accountId = (body.account_id ?? data.account_id) as string | undefined;

  console.log(`[unipile-webhook] event=${event} account=${accountId}`);

  if (IGNORE_EVENTS.has(event)) return json({ ok: true, ignored: true, event });

  const integration = accountId ? await getIntegrationByUnipileId(accountId) : null;

  const isConnectionAccepted =
    CONNECTION_EVENTS.has(event) &&
    (event !== "relation.new" || String(data.status ?? "").toLowerCase().includes("connect"));

  if (isConnectionAccepted) {
    const senderId = (data.sender_id ?? data.profile_id ?? data.provider_id ?? data.id) as string | null;
    const senderUrl = (data.sender_url ?? data.profile_url ?? data.url) as string | null;
    const candidate = await findCandidate(senderId, senderUrl);
    const contact = candidate ? null : await findContact(senderId, senderUrl);
    if (senderId && candidate && !candidate.unipile_id) await stampUnipileId(candidate.table, candidate.id, senderId);
    if (senderId && contact && !contact.unipile_id) await stampUnipileId(contact.table, contact.id, senderId);
    await handleConnectionAccepted(candidate?.id ?? null, contact?.id ?? null);
    return json({ ok: true, event: "connection_accepted", entity: candidate?.id ?? contact?.id ?? null });
  }

  const isMessageEvent = INBOUND_MESSAGE_EVENTS.has(event) || event === "";
  if (!isMessageEvent) return json({ ok: true, ignored: true, event });

  const messageId = (data.id ?? data.message_id) as string | undefined;
  const chatId = (data.chat_id ?? data.chatId) as string | undefined;
  const senderId = (data.sender_id ?? data.senderId ?? (data.sender as Record<string, unknown>)?.id) as string | undefined;
  const senderUrl = (data.sender_url ?? data.senderUrl ?? (data.sender as Record<string, unknown>)?.url) as string | undefined;
  const sentAt = (data.timestamp ?? data.sent_at ?? data.created_at) as string | undefined;
  const isOutbound = (data.is_sender ?? data.outbound ?? false) as boolean;

  if (isOutbound) return json({ ok: true, ignored: true, reason: "outbound_echo" });

  // ── Expanded body extraction: try all known Unipile field paths ──────────
  const messageText = extractMessageText(data);

  // Guard: skip empty-body messages — they are system events or attachment-only
  // messages with no text. Storing blank records creates noise in the inbox.
  if (!messageText) {
    const hasAttachments = Array.isArray(data.attachments) && (data.attachments as unknown[]).length > 0;
    if (!hasAttachments) {
      console.log(`[unipile-webhook] skipping empty-body message ${messageId ?? "no-id"} event=${event}`);
      return json({ ok: true, ignored: true, reason: "empty_body", message_id: messageId });
    }
    // Attachment-only: fall through with a placeholder so it shows in inbox
  }

  const finalBody = messageText || "[Attachment]"; // only reached if hasAttachments + no text

  if (messageId) {
    const { data: existing } = await supabase.from("messages").select("id").eq("unipile_message_id", messageId).maybeSingle();
    if (existing) return json({ ok: true, ignored: true, reason: "duplicate" });
  }

  const candidate = await findCandidate(senderId ?? null, senderUrl ?? null);
  const contact = candidate ? null : await findContact(senderId ?? null, senderUrl ?? null);
  const entity = candidate ?? contact;
  if (entity && senderId && !entity.unipile_id) await stampUnipileId(entity.table, entity.id, senderId);

  const providerType = String(data.provider_type ?? "").toLowerCase();
  const channel = providerType.includes("sales") ? "linkedin_sales_nav"
    : providerType.includes("recruiter") ? "linkedin_recruiter"
    : "linkedin";

  const now = new Date().toISOString();

  let conversationId: string;
  try {
    conversationId = await upsertConversation({
      chatId: chatId ?? null, candidateId: candidate?.id ?? null, contactId: contact?.id ?? null,
      channel, integrationAccountId: integration?.id ?? null, assignedUserId: integration?.owner_user_id ?? null,
    });
  } catch (err) {
    console.error("[unipile-webhook] failed to upsert conversation:", err);
    return json({ ok: false, error: "conversation_upsert_failed" }, 500);
  }

  await supabase.from("conversations").update({
    last_message_preview: finalBody.slice(0, 500), last_message_at: now, is_read: false, updated_at: now,
  }).eq("id", conversationId);

  const { error: insertErr } = await supabase.from("messages").insert({
    conversation_id: conversationId, candidate_id: candidate?.id ?? null, contact_id: contact?.id ?? null,
    integration_account_id: integration?.id ?? null, channel, direction: "inbound", body: finalBody,
    unipile_message_id: messageId ?? null, unipile_chat_id: chatId ?? null,
    sender_address: senderUrl ?? senderId ?? null,
    sent_at: sentAt ? new Date(sentAt).toISOString() : now,
    is_read: false, updated_at: now, inserted_at: now, created_at: now,
  });

  if (insertErr) {
    console.error(`[unipile-webhook] message insert error:`, insertErr.message);
    return json({ ok: false, error: insertErr.message }, 500);
  }

  await handleReplyStop(candidate?.id ?? null, contact?.id ?? null);

  if (finalBody.trim().length > 5 && (candidate?.id || contact?.id)) {
    const enrollmentId = await findActiveEnrollment(candidate?.id ?? null, contact?.id ?? null);
    const sentiment = await analyzeSentiment(finalBody, channel);
    if (sentiment) {
      await saveSentiment({
        candidateId: candidate?.id ?? null, contactId: contact?.id ?? null,
        enrollmentId, channel,
        sentiment: sentiment.sentiment, summary: sentiment.summary,
        rawMessage: finalBody,
      });
      if (candidate?.id) {
        await supabase.from("candidates").update({
          last_sequence_sentiment: sentiment.sentiment,
          last_sequence_sentiment_note: sentiment.summary,
          updated_at: new Date().toISOString(),
        }).eq("id", candidate.id).throwOnError().catch(() => {});
      } else if (contact?.id) {
        await supabase.from("contacts").update({
          last_sequence_sentiment: sentiment.sentiment,
          last_sequence_sentiment_note: sentiment.summary,
          updated_at: new Date().toISOString(),
        }).eq("id", contact.id).throwOnError().catch(() => {});
      }
    }
  }

  console.log(`[unipile-webhook] logged inbound ${channel} from ${senderId ?? senderUrl ?? "unknown"} entity=${entity?.id ?? "unknown"} body_len=${finalBody.length}`);
  return json({ ok: true, entity: entity?.id ?? null, channel, conversation_id: conversationId });
});
