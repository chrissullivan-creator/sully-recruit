import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

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
    const toPhone = eventBody.to?.[0]?.phoneNumber || eventBody.to?.phoneNumber || "";
    const direction = eventBody.direction === "Inbound" ? "inbound" : "outbound";
    const callerPhone = direction === "inbound" ? fromPhone : toPhone;

    if (!callerPhone) {
      logger.info("No phone number in event — skipping");
      return { action: "skipped", reason: "no_phone" };
    }

    const normalizedPhone = callerPhone.replace(/[^0-9+]/g, "");
    const match = await matchByPhone(supabase, normalizedPhone);

    if (!match) {
      logger.info("No matching entity for phone", { phone: normalizedPhone });
      return { action: "no_match", phone: normalizedPhone };
    }

    if (eventType.includes("SMS") || eventBody.messageType === "SMS") {
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

      logger.info("SMS logged", { entityId: match.entityId, direction });
    } else {
      // ── Call event ────────────────────────────────────────────────
      const { data: callLog } = await supabase
        .from("call_logs")
        .insert({
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
        } as any)
        .select("id")
        .single();

      logger.info("Call logged", { entityId: match.entityId, callLogId: callLog?.id });

      // ── Transcribe + extract + summarize (candidates only) ────────
      const isCompletedCall =
        eventBody.result === "Completed" ||
        eventBody.result === "Call connected" ||
        (eventBody.duration && eventBody.duration > 30);

      if (isCompletedCall) {
        await transcribeAndExtract(
          supabase,
          eventBody,
          match.entityId,
          callLog?.id,
          payload.receivedAt,
          match.entityType,
        );
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

    return { action: "logged", entityId: match.entityId, entityType: match.entityType, direction };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIBE + EXTRACT + SUMMARIZE
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_PROMPT = `You are an expert recruiting assistant. You just received a transcript of a phone call between a recruiter and a candidate. Do two things:

1. Write concise call notes summarizing what was discussed (3-8 bullet points).
2. Extract any structured data the candidate mentioned. Return ONLY valid JSON:

{
  "call_notes": "- Bullet point summary of call\\n- Key topics discussed\\n- Action items",
  "candidate_summary": "2-3 sentence professional summary of this candidate based on the call",
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact",
  "sentiment_summary": "One sentence about the candidate's interest level and attitude toward the opportunity",
  "extracted_fields": {
    "current_title": "",
    "current_company": "",
    "reason_for_leaving": "",
    "current_base_comp": "",
    "current_bonus_comp": "",
    "current_total_comp": "",
    "target_base_comp": "",
    "target_total_comp": "",
    "comp_notes": "",
    "work_authorization": "",
    "relocation_preference": "",
    "target_locations": "",
    "target_roles": "",
    "skills": []
  },
  "back_of_resume_points": "Key talking points for the back of resume, separated by newlines"
}

Rules:
- For extracted_fields, only include fields that were explicitly discussed. Use empty string for unknown.
- Comp fields should be plain numbers or ranges like "180000" or "180000-220000".
- back_of_resume_points should capture things a recruiter would want to reference when pitching this candidate: strengths, preferences, red flags, availability, interview readiness.
- Be concise and factual. Don't embellish.`;

async function transcribeAndExtract(
  supabase: any,
  eventBody: any,
  candidateId: string,
  callLogId: string | undefined,
  receivedAt: string,
  entityType: string = "candidate",
) {
  try {
    const anthropicKey = getAnthropicKey();

    // ── 1. Try to fetch call recording from RingCentral ─────────────
    let transcript: string | null = null;
    const recordingUrl = eventBody.recording?.contentUri || eventBody.recordingUrl;

    if (recordingUrl) {
      transcript = await fetchAndTranscribeRecording(supabase, recordingUrl, anthropicKey);
    }

    // If no recording available, check if there's a voicemail transcription
    if (!transcript && eventBody.vmTranscriptionStatus === "Completed") {
      transcript = eventBody.vmTranscription || null;
    }

    // If no recording or transcription, we can't proceed
    if (!transcript || transcript.length < 50) {
      logger.info("No recording/transcript available for call", { candidateId });
      return;
    }

    logger.info("Got transcript", { candidateId, length: transcript.length });

    // ── 2. Extract structured data with Claude ──────────────────────
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: EXTRACT_PROMPT,
        messages: [{ role: "user", content: `Call transcript:\n\n${transcript.slice(0, 12000)}` }],
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error("Claude extraction error", { error: errText });
      return;
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error("No JSON in Claude response");
      return;
    }

    const result = JSON.parse(jsonMatch[0]);
    logger.info("Extracted data from call", { candidateId, fields: Object.keys(result) });

    // ── 3. Store transcript + notes ─────────────────────────────────
    // Insert as a note linked to the candidate
    const noteBody = [
      `## Call Transcript Notes — ${new Date(receivedAt).toLocaleDateString()}`,
      "",
      result.call_notes || "",
      "",
      "---",
      "",
      "### Full Transcript",
      transcript,
    ].join("\n");

    await supabase.from("notes").insert({
      entity_type: entityType,
      entity_id: candidateId,
      content: noteBody,
      created_at: receivedAt,
    } as any);

    // ── 4. Update entity fields ────────────────────────────────────
    const fields = result.extracted_fields || {};
    const table = entityType === "candidate" ? "candidates" : "contacts";
    const updates: any = {};

    // Basic fields — apply to both candidates and contacts
    if (fields.current_title) updates.current_title = entityType === "contact" ? undefined : fields.current_title;
    if (fields.current_title && entityType === "contact") updates.title = fields.current_title;
    if (fields.current_company) {
      if (entityType === "candidate") updates.current_company = fields.current_company;
      else updates.company_name = fields.current_company;
    }

    // Candidate-only fields
    if (entityType === "candidate") {
      if (fields.reason_for_leaving) updates.reason_for_leaving = fields.reason_for_leaving;
      if (fields.current_base_comp) updates.current_base_comp = fields.current_base_comp;
      if (fields.current_bonus_comp) updates.current_bonus_comp = fields.current_bonus_comp;
      if (fields.current_total_comp) updates.current_total_comp = fields.current_total_comp;
      if (fields.target_base_comp) updates.target_base_comp = fields.target_base_comp;
      if (fields.target_total_comp) updates.target_total_comp = fields.target_total_comp;
      if (fields.comp_notes) updates.comp_notes = fields.comp_notes;
      if (fields.work_authorization) updates.work_authorization = fields.work_authorization;
      if (fields.relocation_preference) updates.relocation_preference = fields.relocation_preference;
      if (fields.target_locations) updates.target_locations = fields.target_locations;
      if (fields.target_roles) updates.target_roles = fields.target_roles;
      if (fields.skills?.length) updates.skills = fields.skills;

      // Update candidate_summary
      if (result.candidate_summary) {
        updates.candidate_summary = result.candidate_summary;
      }

      // Append to back_of_resume_notes (don't overwrite existing)
      if (result.back_of_resume_points) {
        const { data: existing } = await supabase
          .from("candidates")
          .select("back_of_resume_notes")
          .eq("id", candidateId)
          .single();

        const dateLabel = new Date(receivedAt).toLocaleDateString();
        const newPoints = `\n\n--- Call Notes (${dateLabel}) ---\n${result.back_of_resume_points}`;

        updates.back_of_resume_notes = existing?.back_of_resume_notes
          ? existing.back_of_resume_notes + newPoints
          : newPoints.trim();
      }

      // Update joe_says with key takeaway
      if (result.candidate_summary) {
        updates.joe_says = `Last call: ${result.candidate_summary}`;
        updates.joe_says_updated_at = receivedAt;
      }
    }

    // Remove undefined keys
    Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);

    if (Object.keys(updates).length > 0) {
      await supabase.from(table).update(updates).eq("id", candidateId);
      logger.info(`Updated ${entityType} fields from call`, {
        entityId: candidateId,
        updatedFields: Object.keys(updates),
      });
    }

    // ── 5. Sentiment analysis + pipeline automation from call ───────
    if (result.sentiment && entityType === "candidate") {
      // Store sentiment
      await supabase.from("reply_sentiment").insert({
        candidate_id: candidateId,
        channel: "phone",
        sentiment: result.sentiment,
        summary: result.sentiment_summary || result.candidate_summary || "",
        raw_message: transcript?.slice(0, 1000) || "",
        analyzed_at: receivedAt,
      } as any);

      // Update candidate sentiment fields
      await supabase
        .from("candidates")
        .update({
          last_sequence_sentiment: result.sentiment,
          last_sequence_sentiment_note: result.sentiment_summary || result.candidate_summary || "",
        } as any)
        .eq("id", candidateId);

      // Pipeline automation
      const negativeSentiments = ["negative", "not_interested", "do_not_contact"];
      const positiveSentiments = ["interested", "positive"];

      if (negativeSentiments.includes(result.sentiment)) {
        const { data: rejected } = await supabase
          .from("send_outs")
          .update({
            stage: "rejected",
            rejected_by: "candidate",
            rejection_reason: result.sentiment.replace(/_/g, " "),
            feedback: result.sentiment_summary || result.candidate_summary || "",
            updated_at: new Date().toISOString(),
          } as any)
          .eq("candidate_id", candidateId)
          .not("stage", "in", '("rejected","placed")')
          .select("id");

        if (rejected && rejected.length > 0) {
          logger.info("Pipeline auto-rejected by candidate call sentiment", {
            candidateId, sentiment: result.sentiment, sendOutIds: rejected.map((s: any) => s.id),
          });
        }
      } else if (positiveSentiments.includes(result.sentiment)) {
        const { data: advanced } = await supabase
          .from("send_outs")
          .update({ stage: "pitch", updated_at: new Date().toISOString() } as any)
          .eq("candidate_id", candidateId)
          .in("stage", ["new", "reached_out"])
          .select("id");

        if (advanced && advanced.length > 0) {
          logger.info("Pipeline auto-advanced to pitch on positive call sentiment", {
            candidateId, sentiment: result.sentiment, sendOutIds: advanced.map((s: any) => s.id),
          });
        }
      }

      logger.info("Call sentiment analyzed", { candidateId, sentiment: result.sentiment });
    }
  } catch (err: any) {
    logger.error("Transcribe/extract error", { candidateId, error: err.message });
    // Non-critical — don't throw, call was already logged
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH AND TRANSCRIBE RECORDING
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndTranscribeRecording(
  supabase: any,
  recordingUrl: string,
  anthropicKey: string,
): Promise<string | null> {
  try {
    // Get RingCentral access token from any active user's integration
    // (recording download works with any valid RC token for the account)
    const { data: rcIntegration } = await supabase
      .from("user_integrations")
      .select("config")
      .eq("integration_type", "ringcentral")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (!rcIntegration?.config) {
      logger.warn("No active RingCentral integration — cannot fetch recording");
      return null;
    }

    const config = rcIntegration.config as any;
    const clientId = config.client_id;
    const clientSecret = config.client_secret;
    const jwtToken = config.jwt_token;
    const serverUrl = config.server_url || "https://platform.ringcentral.com";

    if (!clientId || !clientSecret || !jwtToken) {
      logger.warn("RingCentral credentials incomplete — cannot fetch recording");
      return null;
    }

    const authResp = await fetch(`${serverUrl}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwtToken,
      }),
    });

    if (!authResp.ok) {
      logger.error("RingCentral auth failed for recording download");
      return null;
    }

    const { access_token } = await authResp.json();

    // Download the recording
    const recordingResp = await fetch(recordingUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!recordingResp.ok) {
      logger.error("Failed to download recording", { status: recordingResp.status });
      return null;
    }

    const audioBuffer = await recordingResp.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString("base64");
    const contentType = recordingResp.headers.get("content-type") || "audio/mpeg";

    logger.info("Downloaded recording", { size: audioBuffer.byteLength, contentType });

    // Transcribe with Claude using audio input
    const transcribeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: contentType,
                  data: audioBase64,
                },
              },
              {
                type: "text",
                text: "Transcribe this phone call recording between a recruiter and a candidate. Include speaker labels (Recruiter / Candidate) where you can distinguish them. Capture everything said — don't summarize, just transcribe.",
              },
            ],
          },
        ],
        temperature: 0,
      }),
    });

    if (!transcribeResp.ok) {
      const errText = await transcribeResp.text();
      logger.error("Claude transcription error", { error: errText });
      return null;
    }

    const transcribeData = await transcribeResp.json();
    return transcribeData.content?.[0]?.text || null;
  } catch (err: any) {
    logger.error("Recording fetch/transcribe error", { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE MATCHING
// ─────────────────────────────────────────────────────────────────────────────
async function matchByPhone(
  supabase: any,
  normalizedPhone: string,
): Promise<{ entityId: string; entityType: string; entityColumn: string } | null> {
  const normalize = (p: string) => p.replace(/[^0-9]/g, "");
  const last10 = (p: string) => normalize(p).slice(-10);
  const searchDigits = last10(normalizedPhone);

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, phone")
    .not("phone", "is", null);

  // Try exact match first, then last-10-digits match
  const candidateExact = candidates?.find(
    (c: any) => c.phone && normalize(c.phone) === normalize(normalizedPhone),
  );
  if (candidateExact) {
    return { entityId: candidateExact.id, entityType: "candidate", entityColumn: "candidate_id" };
  }
  const candidateFuzzy = candidates?.find(
    (c: any) => c.phone && last10(c.phone) === searchDigits && searchDigits.length === 10,
  );
  if (candidateFuzzy) {
    return { entityId: candidateFuzzy.id, entityType: "candidate", entityColumn: "candidate_id" };
  }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, phone")
    .not("phone", "is", null);

  const contactExact = contacts?.find(
    (c: any) => c.phone && normalize(c.phone) === normalize(normalizedPhone),
  );
  if (contactExact) {
    return { entityId: contactExact.id, entityType: "contact", entityColumn: "contact_id" };
  }
  const contactFuzzy = contacts?.find(
    (c: any) => c.phone && last10(c.phone) === searchDigits && searchDigits.length === 10,
  );
  if (contactFuzzy) {
    return { entityId: contactFuzzy.id, entityType: "contact", entityColumn: "contact_id" };
  }

  return null;
}
