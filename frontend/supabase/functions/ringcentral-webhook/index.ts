import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, validation-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Constant-time string compare so the verification token can't be timed out. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ── Sentiment analysis (SMS inbound) ───────────────────────────────
async function analyzeSentiment(messageText: string, channel: string): Promise<{ sentiment: string; summary: string } | null> {
  if (!ANTHROPIC_API_KEY || !messageText.trim() || messageText.trim().length < 5) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `You analyze inbound replies to recruiting outreach from a Wall Street recruiting firm. Classify sentiment and write a crisp 1-2 sentence note for the recruiter.

Respond ONLY with valid JSON, no markdown:
{"sentiment": "...", "summary": "..."}

Sentiment: interested | positive | maybe | neutral | negative | not_interested | do_not_contact`,
        messages: [{ role: "user", content: `Channel: ${channel}\n\nMessage:\n${messageText.slice(0, 1500)}` }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = JSON.parse((data.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
    return parsed.sentiment && parsed.summary ? parsed : null;
  } catch { return null; }
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

async function findActiveEnrollment(candidateId: string | null, contactId: string | null): Promise<string | null> {
  const col = candidateId ? "candidate_id" : "contact_id";
  const val = candidateId ?? contactId;
  if (!val) return null;
  const { data } = await supabase.from("sequence_enrollments")
    .select("id").eq(col, val).eq("status", "active")
    .order("enrolled_at", { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

async function findCandidateByPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const variants = [phone, `+${digits}`, digits,
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null].filter(Boolean) as string[];
  for (const v of variants) {
    const { data } = await supabase.from("candidates").select("id, full_name").eq("phone", v).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function findContactByPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const variants = [phone, `+${digits}`, digits,
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null].filter(Boolean) as string[];
  for (const v of variants) {
    const { data } = await supabase.from("contacts").select("id, full_name").eq("phone", v).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function findIntegrationAccountByPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const { data } = await supabase.from("integration_accounts").select("id, owner_user_id, account_label")
    .eq("provider", "sms").eq("is_active", true)
    .or(`rc_phone_number.eq.${phone},rc_phone_number.eq.+${digits}`).maybeSingle();
  return data;
}

async function handleReplyStop(candidateId: string | null, contactId: string | null) {
  const col = candidateId ? "candidate_id" : "contact_id";
  const val = candidateId ?? contactId;
  if (!val) return;
  const { data: enrollments } = await supabase.from("sequence_enrollments")
    .select("id, sequence_id").eq(col, val).eq("status", "active");
  for (const e of enrollments ?? []) {
    const { data: seq } = await supabase.from("sequences").select("stop_on_reply").eq("id", e.sequence_id).maybeSingle();
    if (seq?.stop_on_reply) {
      await supabase.from("sequence_enrollments").update({
        status: "stopped", stopped_reason: "reply_received_sms", updated_at: new Date().toISOString(),
      }).eq("id", e.id);
    }
  }
}

// ── Handle telephony/sessions call-ended event ──────────────────────────
async function handleCallCompleted(payload: Record<string, unknown>) {
  try {
    const body = payload.body as Record<string, unknown> ?? payload;
    const sessions = (body.parties ?? [body]) as Record<string, unknown>[];

    for (const session of sessions) {
      const status = String((session.status as Record<string, unknown>)?.code ?? session.status ?? "").toLowerCase();
      if (!status.includes("disconnect") && !status.includes("gone") && !status.includes("completed")) continue;

      const recordings = (session.recordings ?? body.recordings ?? []) as Record<string, unknown>[];
      if (!recordings.length) {
        console.log("[rc-webhook] call ended but no recording attached");
        continue;
      }

      for (const rec of recordings) {
        const recordingId = String(rec.id ?? "");
        const recordingUrl = String(rec.contentUri ?? rec.content_uri ?? "");
        if (!recordingId && !recordingUrl) continue;

        // Get call metadata
        const from = (body.from ?? session.from ?? {}) as Record<string, unknown>;
        const to = (body.to ?? session.to ?? {}) as Record<string, unknown>;
        const fromNumber = String(from.phoneNumber ?? from.extensionNumber ?? "");
        const toNumber = String(to.phoneNumber ?? to.extensionNumber ?? "");
        const direction = String(body.direction ?? session.direction ?? "Outbound").toLowerCase();
        const durationMs = Number(rec.duration ?? body.duration ?? 0);
        const durationSec = durationMs > 1000 ? Math.round(durationMs / 1000) : durationMs;
        const sessionId = String(body.sessionId ?? body.id ?? rec.id ?? "");
        const startTime = String(body.startTime ?? body.startedAt ?? "");
        const endTime = String(body.endTime ?? body.endedAt ?? new Date().toISOString());

        // Skip short calls
        if (durationSec < 30) {
          console.log(`[rc-webhook] skipping short call ${sessionId} (${durationSec}s)`);
          continue;
        }

        // Find candidate/contact from phone numbers
        const callerNumber = direction === "outbound" ? toNumber : fromNumber;
        const candidate = callerNumber ? await findCandidateByPhone(callerNumber) : null;
        const contact = candidate ? null : (callerNumber ? await findContactByPhone(callerNumber) : null);

        // Find recruiter account
        const recruiterNumber = direction === "outbound" ? fromNumber : toNumber;
        const integration = recruiterNumber ? await findIntegrationAccountByPhone(recruiterNumber) : null;

        console.log(`[rc-webhook] call ended: session=${sessionId} duration=${durationSec}s entity=${candidate?.id ?? contact?.id ?? "unknown"} recording=${recordingId}`);

        // Fire-and-forget: call process-call-recording
        const processUrl = `${SUPABASE_URL}/functions/v1/process-call-recording`;
        fetch(processUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            recording_url: recordingUrl || null,
            recording_id: recordingId || null,
            call_id: sessionId,
            candidate_id: candidate?.id ?? null,
            contact_id: contact?.id ?? null,
            owner_id: integration?.owner_user_id ?? null,
            call_direction: direction,
            call_duration_seconds: durationSec,
            call_started_at: startTime || null,
            call_ended_at: endTime,
            phone_number: callerNumber,
          }),
        }).then(r => console.log(`[rc-webhook] process-call-recording triggered: ${r.status}`))
          .catch(e => console.warn(`[rc-webhook] process-call-recording trigger failed:`, e?.message));
      }
    }
  } catch (err: any) {
    console.error("[rc-webhook] handleCallCompleted error:", err?.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // RingCentral webhook validation handshake
  const validationToken = req.headers.get("validation-token");
  if (validationToken) {
    return new Response(null, { status: 200, headers: { ...corsHeaders, "validation-token": validationToken } });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Verify the event really came from RingCentral. This endpoint previously had
  // NO authentication on POSTs, so anyone who learned the URL could forge SMS /
  // call events — including supplying an attacker-controlled recording URL that
  // gets handed to the transcription pipeline. Mirror the canonical Vercel
  // handler (api/webhooks/ringcentral.ts): RingCentral echoes the subscription's
  // verificationToken in the `Verification-Token` header on every notification.
  // Fail closed in strict mode; set RINGCENTRAL_WEBHOOK_STRICT=false to
  // log-and-accept during a subscription rotation.
  const expectedToken = Deno.env.get("RINGCENTRAL_WEBHOOK_TOKEN") ?? "";
  const strict = (Deno.env.get("RINGCENTRAL_WEBHOOK_STRICT") ?? "true").toLowerCase() !== "false";
  if (strict) {
    if (!expectedToken) {
      console.error("[rc-webhook] RINGCENTRAL_WEBHOOK_TOKEN not set — refusing (set RINGCENTRAL_WEBHOOK_STRICT=false to bypass during rotation)");
      return json({ error: "Webhook token not configured" }, 500);
    }
    const incoming = req.headers.get("verification-token") ?? "";
    if (!timingSafeEqualStr(incoming, expectedToken)) {
      console.warn("[rc-webhook] verification-token mismatch", { hasHeader: !!incoming });
      return json({ error: "Invalid verification token" }, 401);
    }
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const event = String(body.event ?? "").toLowerCase();
  const payload = (body.body ?? body) as Record<string, unknown>;

  console.log("[rc-webhook] event:", event, JSON.stringify(body).slice(0, 200));

  // ── Call completed event ──
  const isCallEvent = event.includes("telephony") || event.includes("call") || event.includes("account/telephony");
  if (isCallEvent) {
    await handleCallCompleted(body);
    return json({ ok: true, event: "call_processed" });
  }

  // ── SMS event ──
  const isSmsEvent = event.includes("message-store") || event.includes("sms") || !event;
  if (!isSmsEvent) return json({ ok: true, ignored: true, event });

  const changes = (payload.changes ?? [payload]) as Record<string, unknown>[];
  let processed = 0;

  for (const change of changes) {
    const msgType = String(change.type ?? "").toUpperCase();
    if (msgType && msgType !== "SMS") continue;

    const from = (change.from ?? payload.from) as Record<string, unknown> | undefined;
    const to = (change.to ?? payload.to) as Record<string, unknown>[] | undefined;
    const fromNumber = String(from?.phoneNumber ?? from?.extensionNumber ?? "");
    const toNumber = String(to?.[0]?.phoneNumber ?? to?.[0]?.extensionNumber ?? "");
    const text = String(change.subject ?? change.text ?? payload.subject ?? payload.text ?? "");
    const messageId = String(change.id ?? payload.id ?? crypto.randomUUID());
    const direction = String(change.direction ?? payload.direction ?? "Inbound").toLowerCase();
    const sentAt = String(change.creationTime ?? payload.creationTime ?? new Date().toISOString());

    if (direction !== "inbound") continue;
    if (!fromNumber) continue;

    // Dedup
    const { data: existing } = await supabase.from("messages").select("id")
      .eq("provider_message_id", messageId).maybeSingle();
    if (existing) continue;

    const integration = toNumber ? await findIntegrationAccountByPhone(toNumber) : null;
    const candidate = await findCandidateByPhone(fromNumber);
    const contact = candidate ? null : await findContactByPhone(fromNumber);
    const candidateId = candidate?.id ?? null;
    const contactId = contact?.id ?? null;

    const now = new Date().toISOString();
    await supabase.from("messages").insert({
      conversation_id: crypto.randomUUID(),
      candidate_id: candidateId, contact_id: contactId,
      integration_account_id: integration?.id ?? null,
      channel: "sms", direction: "inbound",
      body: text, sender_address: fromNumber, recipient_address: toNumber || null,
      provider_message_id: messageId,
      sent_at: sentAt ? new Date(sentAt).toISOString() : now,
      is_read: false, updated_at: now, inserted_at: now, created_at: now,
      raw_payload: body,
    });

    await handleReplyStop(candidateId, contactId);

    // Claude sentiment on inbound SMS
    if (text.trim().length > 5 && (candidateId || contactId)) {
      const enrollmentId = await findActiveEnrollment(candidateId, contactId);
      const sentiment = await analyzeSentiment(text, "sms");
      if (sentiment) {
        await saveSentiment({ candidateId, contactId, enrollmentId, channel: "sms", ...sentiment, rawMessage: text });
        const table = candidateId ? "candidates" : "contacts";
        const id = candidateId ?? contactId!;
        await supabase.from(table).update({
          last_sequence_sentiment: sentiment.sentiment,
          last_sequence_sentiment_note: sentiment.summary,
          updated_at: new Date().toISOString(),
        }).eq("id", id).throwOnError().catch(() => {});
      }
    }

    processed++;
  }

  return json({ ok: true, processed });
});
