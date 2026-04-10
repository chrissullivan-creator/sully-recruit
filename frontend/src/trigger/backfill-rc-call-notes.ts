import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

// One-shot backfill: for every call_logs row without an ai_call_notes row,
// re-fetch the recording from RingCentral, transcribe + extract with Claude,
// insert into ai_call_notes, and stamp call_logs.summary.
//
// Safe to re-run: dedupes by checking for existing ai_call_notes.call_log_id.
// Invoke from the Trigger.dev dashboard with an empty payload, or
// { "dryRun": true } / { "limit": 5 } / { "callLogId": "<uuid>" } to test.

const RC_SERVER = "https://platform.ringcentral.com";

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
    "skills": [],
    "location": "",
    "notice_period": ""
  },
  "back_of_resume_points": "Key talking points for the back of resume, separated by newlines"
}

Rules:
- For extracted_fields, only include fields that were explicitly discussed. Use empty string for unknown.
- Comp fields should be plain numbers or ranges like "180000" or "180000-220000".
- back_of_resume_points should capture things a recruiter would want to reference when pitching this candidate: strengths, preferences, red flags, availability, interview readiness.
- Be concise and factual. Don't embellish.`;

interface BackfillPayload {
  limit?: number; // Max calls to process in this run (default: all eligible)
  dryRun?: boolean; // Log what would happen without writing
  callLogId?: string; // Process a single call_log (for testing)
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

async function getRcToken(
  acct: any,
  cache: Map<string, TokenCacheEntry>,
): Promise<string | null> {
  const cached = cache.get(acct.owner_user_id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const meta = acct.metadata ?? {};
  const clientId = meta.rc_client_id;
  const clientSecret = meta.rc_client_secret;
  const jwt = acct.rc_jwt;
  if (!clientId || !clientSecret || !jwt) {
    logger.warn("RC credentials incomplete on account", { account: acct.account_label });
    return null;
  }

  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    logger.warn("RC token refresh failed", { status: res.status, account: acct.account_label });
    return null;
  }
  const data = await res.json();
  const token = data.access_token;
  if (!token) return null;
  cache.set(acct.owner_user_id, {
    token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return token;
}

async function fetchCallDetail(token: string, externalCallId: string): Promise<any | null> {
  const res = await fetch(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log/${externalCallId}?view=Detailed`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    logger.warn("Call detail fetch failed", { status: res.status, externalCallId });
    return null;
  }
  return await res.json();
}

async function downloadAndTranscribeRecording(
  recordingUrl: string,
  rcToken: string,
  anthropicKey: string,
): Promise<string | null> {
  const recordingResp = await fetch(recordingUrl, {
    headers: { Authorization: `Bearer ${rcToken}` },
  });
  if (!recordingResp.ok) {
    logger.warn("Failed to download recording", { status: recordingResp.status });
    return null;
  }
  const audioBuffer = await recordingResp.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");
  const contentType = recordingResp.headers.get("content-type") || "audio/mpeg";

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
              source: { type: "base64", media_type: contentType, data: audioBase64 },
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
  const data = await transcribeResp.json();
  return data.content?.[0]?.text || null;
}

async function extractStructuredData(transcript: string, anthropicKey: string): Promise<any | null> {
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
    logger.error("Claude extraction error", { status: resp.status });
    return null;
  }
  const data = await resp.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

async function matchByPhoneLast10(
  supabase: any,
  phone: string,
): Promise<{ entityId: string; entityType: string } | null> {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  if (last10.length !== 10) return null;

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, phone")
    .not("phone", "is", null);
  const cand = (candidates || []).find(
    (c: any) => c.phone && c.phone.replace(/\D/g, "").slice(-10) === last10,
  );
  if (cand) return { entityId: cand.id, entityType: "candidate" };

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, phone")
    .not("phone", "is", null);
  const cont = (contacts || []).find(
    (c: any) => c.phone && c.phone.replace(/\D/g, "").slice(-10) === last10,
  );
  if (cont) return { entityId: cont.id, entityType: "contact" };

  return null;
}

export const backfillRcCallNotes = task({
  id: "backfill-rc-call-notes",
  maxDuration: 1800, // 30 minutes — transcription is slow
  retry: { maxAttempts: 1 },
  run: async (payload: BackfillPayload = {}) => {
    const supabase = getSupabaseAdmin();
    const anthropicKey = await getAnthropicKey();
    const tokenCache = new Map<string, TokenCacheEntry>();

    // 1. Find eligible call_logs (has external_call_id, duration >= 30s)
    let query = supabase
      .from("call_logs")
      .select(
        "id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id",
      )
      .not("external_call_id", "is", null)
      .gte("duration_seconds", 30)
      .order("started_at", { ascending: false });

    if (payload.callLogId) {
      query = query.eq("id", payload.callLogId);
    }

    const { data: eligible, error: queryErr } = await query;
    if (queryErr) {
      logger.error("Failed to query call_logs", { error: queryErr.message });
      throw queryErr;
    }

    // 2. Filter out any that already have an ai_call_note
    const eligibleIds = (eligible || []).map((c: any) => c.id);
    let alreadyNotedIds: Set<string> = new Set();
    if (eligibleIds.length > 0) {
      const { data: existingNotes } = await supabase
        .from("ai_call_notes")
        .select("call_log_id")
        .in("call_log_id", eligibleIds);
      alreadyNotedIds = new Set((existingNotes || []).map((n: any) => n.call_log_id));
    }

    let toProcess = (eligible || []).filter((c: any) => !alreadyNotedIds.has(c.id));
    if (payload.limit) toProcess = toProcess.slice(0, payload.limit);

    logger.info("Backfill starting", {
      eligibleCount: (eligible || []).length,
      alreadyNoted: alreadyNotedIds.size,
      toProcess: toProcess.length,
      dryRun: !!payload.dryRun,
    });

    // 3. Load RC accounts keyed by owner_user_id
    const { data: rcAccounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
      .eq("provider", "sms")
      .eq("is_active", true)
      .not("rc_jwt", "is", null);
    const acctByOwner = new Map<string, any>();
    for (const a of rcAccounts || []) acctByOwner.set(a.owner_user_id, a);

    const stats = {
      total: toProcess.length,
      processed: 0,
      notes_created: 0,
      no_recording: 0,
      no_transcript: 0,
      rc_error: 0,
      claude_error: 0,
      entity_matched: 0,
      insert_error: 0,
    };

    for (const cl of toProcess) {
      stats.processed++;
      try {
        const acct = acctByOwner.get(cl.owner_id);
        if (!acct) {
          logger.warn("No active RC account for owner", {
            callLogId: cl.id,
            owner: cl.owner_id,
          });
          stats.rc_error++;
          continue;
        }

        const token = await getRcToken(acct, tokenCache);
        if (!token) {
          stats.rc_error++;
          continue;
        }

        const detail = await fetchCallDetail(token, cl.external_call_id);
        if (!detail) {
          stats.rc_error++;
          continue;
        }

        const recordingUrl: string | undefined = detail.recording?.contentUri;
        if (!recordingUrl) {
          logger.info("No recording on RC call", { callLogId: cl.id });
          stats.no_recording++;
          continue;
        }

        if (payload.dryRun) {
          logger.info("[dry-run] would process", {
            callLogId: cl.id,
            phone: cl.phone_number,
            duration: cl.duration_seconds,
            recordingUrl,
          });
          continue;
        }

        const transcript = await downloadAndTranscribeRecording(
          recordingUrl,
          token,
          anthropicKey,
        );
        if (!transcript || transcript.length < 50) {
          logger.info("No transcript produced", { callLogId: cl.id });
          stats.no_transcript++;
          continue;
        }

        const result = await extractStructuredData(transcript, anthropicKey);
        if (!result) {
          stats.claude_error++;
          continue;
        }

        // Re-match entity by phone if un-linked
        let entityType = cl.linked_entity_type as string | null;
        let entityId = cl.linked_entity_id as string | null;
        if (!entityId && cl.phone_number) {
          const matched = await matchByPhoneLast10(supabase, cl.phone_number);
          if (matched) {
            entityType = matched.entityType;
            entityId = matched.entityId;
            stats.entity_matched++;
            await supabase
              .from("call_logs")
              .update({
                linked_entity_type: matched.entityType,
                linked_entity_id: matched.entityId,
              } as any)
              .eq("id", cl.id);
          }
        }

        const aiNoteInsert: any = {
          call_log_id: cl.id,
          external_call_id: cl.external_call_id,
          phone_number: cl.phone_number,
          call_direction: cl.direction,
          call_duration_seconds: cl.duration_seconds || 0,
          call_started_at: cl.started_at,
          call_ended_at: cl.ended_at,
          recording_url: recordingUrl,
          transcript,
          ai_summary: result.call_notes || null,
          ai_action_items: result.back_of_resume_points || null,
          processing_status: "completed",
          structured_notes: result,
          source: "backfill",
          owner_id: cl.owner_id,
        };

        if (entityType === "candidate" && entityId) {
          aiNoteInsert.candidate_id = entityId;
        } else if (entityType === "contact" && entityId) {
          aiNoteInsert.contact_id = entityId;
        }

        const { error: insertErr } = await supabase.from("ai_call_notes").insert(aiNoteInsert);
        if (insertErr) {
          logger.error("Failed to insert ai_call_notes", {
            callLogId: cl.id,
            error: insertErr.message,
          });
          stats.insert_error++;
          continue;
        }

        if (result.call_notes) {
          await supabase
            .from("call_logs")
            .update({ summary: result.call_notes } as any)
            .eq("id", cl.id);
        }

        stats.notes_created++;
        logger.info("Backfilled ai_call_note", {
          callLogId: cl.id,
          progress: `${stats.processed}/${stats.total}`,
        });
      } catch (err: any) {
        logger.error("Unexpected error processing call", {
          callLogId: cl.id,
          error: err?.message,
        });
        stats.claude_error++;
      }
    }

    logger.info("Backfill complete", stats);
    return stats;
  },
});
