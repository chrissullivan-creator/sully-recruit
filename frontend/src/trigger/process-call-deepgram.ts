import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getAppSetting } from "./lib/supabase";

const RC_SERVER = "https://platform.ringcentral.com";

/**
 * Process a single call recording: download from RC → transcribe via Deepgram
 * Nova-3 → extract intel with Joe (Claude Sonnet) → write ai_call_notes →
 * update call_logs + candidate fields.
 *
 * Invoke manually from the Trigger.dev dashboard with:
 *   { "call_log_id": "<uuid>" }           — process a specific call
 *   { "batch": true, "limit": 50 }        — process up to N un-noted calls
 *   { "batch": true, "limit": 50, "dry_run": true }  — preview without writing
 *
 * Also used as the go-forward processor: poll-rc-calls or the webhook can
 * .trigger() this task after inserting a new call_log row.
 */
export const processCallDeepgram = task({
  id: "process-call-deepgram",
  maxDuration: 1800, // 30 minutes — handles even 2-hour recordings
  retry: { maxAttempts: 2 },
  run: async (payload: {
    call_log_id?: string;
    batch?: boolean;
    limit?: number;
    dry_run?: boolean;
  }) => {
    const supabase = getSupabaseAdmin();
    const anthropicKey = await getAnthropicKey();
    const deepgramKey = await getAppSetting("DEEPGRAM_API_KEY");
    if (!deepgramKey) throw new Error("DEEPGRAM_API_KEY not found in app_settings");

    // ── Find calls to process ───────────────────────────────────────
    let toProcess: any[] = [];

    if (payload.call_log_id) {
      const { data } = await supabase
        .from("call_logs")
        .select("id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id")
        .eq("id", payload.call_log_id)
        .single();
      if (data) toProcess = [data];
    } else if (payload.batch) {
      const limit = payload.limit ?? 50;
      const { data: eligible } = await supabase
        .from("call_logs")
        .select("id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id")
        .not("external_call_id", "is", null)
        .gte("duration_seconds", 30)
        .order("started_at", { ascending: false });

      const ids = (eligible ?? []).map((c: any) => c.id);
      const { data: existingNotes } = await supabase
        .from("ai_call_notes")
        .select("call_log_id")
        .in("call_log_id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const noted = new Set((existingNotes ?? []).map((n: any) => n.call_log_id));
      toProcess = (eligible ?? []).filter((c: any) => !noted.has(c.id)).slice(0, limit);
    }

    if (!toProcess.length) {
      logger.info("Nothing to process");
      return { processed: 0, message: "No un-noted calls" };
    }

    // ── Get RC tokens ───────────────────────────────────────────────
    const owners = [...new Set(toProcess.map((c: any) => c.owner_id))];
    const tokens: Record<string, string> = {};
    for (const ownerId of owners) {
      const t = await getRCToken(supabase, ownerId);
      if (t) tokens[ownerId] = t;
    }

    // ── Bulk-fetch call-log per owner to get recording.id ───────────
    const lookups: Record<string, Map<string, any>> = {};
    for (const ownerId of owners) {
      const token = tokens[ownerId];
      if (!token) continue;
      const ownerCalls = toProcess.filter((c: any) => c.owner_id === ownerId);
      const sorted = ownerCalls.slice().sort(
        (a: any, b: any) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      );
      const dateFrom = new Date(new Date(sorted[0].started_at).getTime() - 86400000)
        .toISOString().replace(/\.\d{3}Z$/, "Z");
      const dateTo = new Date(new Date(sorted[sorted.length - 1].started_at).getTime() + 86400000)
        .toISOString().replace(/\.\d{3}Z$/, "Z");
      const records = await fetchCallsInRange(token, dateFrom, dateTo);
      lookups[ownerId] = buildLookup(records);
      logger.info("RC lookup built", { ownerId, records: records.length, keys: lookups[ownerId].size });
    }

    // ── Process each call ───────────────────────────────────────────
    const stats = {
      total: toProcess.length, processed: 0, transcribed: 0,
      no_rc_match: 0, no_recording: 0, no_transcript: 0,
      joe_error: 0, insert_error: 0, dry_run_ready: 0,
    };

    for (const cl of toProcess) {
      stats.processed++;
      const token = tokens[cl.owner_id];
      if (!token) { stats.no_rc_match++; continue; }

      const rcRecord = lookups[cl.owner_id]?.get(String(cl.external_call_id));
      if (!rcRecord) { stats.no_rc_match++; continue; }

      let recordingId = rcRecord.recording?.id;
      if (!recordingId) {
        for (const leg of rcRecord.legs ?? []) {
          if (leg.recording?.id) { recordingId = leg.recording.id; break; }
        }
      }
      const contentUri = rcRecord.recording?.contentUri ?? rcRecord.legs?.[0]?.recording?.contentUri ?? null;
      if (!recordingId || !contentUri) { stats.no_recording++; continue; }

      if (payload.dry_run) {
        stats.dry_run_ready++;
        logger.info("dry-run", { call: cl.external_call_id, recording: recordingId, duration: cl.duration_seconds });
        continue;
      }

      // ── Download audio from RC ──────────────────────────────────
      logger.info("Downloading audio", { call: cl.external_call_id, duration: cl.duration_seconds });
      const audioResp = await fetch(contentUri, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120000),
      });
      if (!audioResp.ok) {
        logger.warn("Audio download failed", { status: audioResp.status });
        stats.no_transcript++;
        continue;
      }
      const audioBytes = await audioResp.arrayBuffer();
      const audioContentType = audioResp.headers.get("content-type") || "audio/mpeg";
      logger.info("Audio downloaded", { bytes: audioBytes.byteLength, type: audioContentType });

      // ── Deepgram Nova-3 transcription ───────────────────────────
      const dgResp = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=en&punctuate=true&paragraphs=true",
        {
          method: "POST",
          headers: { Authorization: `Token ${deepgramKey}`, "Content-Type": audioContentType },
          body: audioBytes,
          signal: AbortSignal.timeout(300000), // 5 min for very long calls
        },
      );
      if (!dgResp.ok) {
        const err = await dgResp.text().catch(() => "");
        logger.error("Deepgram failed", { status: dgResp.status, error: err.slice(0, 200) });
        stats.no_transcript++;
        continue;
      }

      const dg = await dgResp.json();
      let transcript: string | null = null;

      // Speaker-labeled paragraphs
      const paragraphs = dg.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs;
      if (paragraphs?.length) {
        const lines = paragraphs
          .map((p: any) => {
            const speaker = p.speaker === 0 ? "Recruiter" : `Speaker ${p.speaker + 1}`;
            const text = (p.sentences ?? []).map((s: any) => s.text).join(" ");
            return text.trim() ? `${speaker}: ${text}` : null;
          })
          .filter(Boolean);
        if (lines.length) transcript = lines.join("\n");
      }
      // Fallback: plain transcript
      if (!transcript) {
        transcript = dg.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;
      }

      if (!transcript || transcript.length < 30) {
        logger.warn("No usable transcript", { call: cl.external_call_id });
        stats.no_transcript++;
        continue;
      }

      stats.transcribed++;
      logger.info("Transcribed", { call: cl.external_call_id, chars: transcript.length });

      // ── Entity matching ─────────────────────────────────────────
      let entityId = cl.linked_entity_id;
      let entityType = cl.linked_entity_type;
      let entityName = "candidate";

      if (!entityId && cl.phone_number) {
        const last10 = cl.phone_number.replace(/\D/g, "").slice(-10);
        if (last10.length === 10) {
          const { data: cands } = await supabase.from("candidates").select("id, full_name, phone").not("phone", "is", null);
          const match = (cands ?? []).find((c: any) => c.phone?.replace(/\D/g, "").slice(-10) === last10);
          if (match) {
            entityId = match.id; entityType = "candidate"; entityName = match.full_name;
            await supabase.from("call_logs").update({
              linked_entity_type: "candidate", linked_entity_id: match.id, linked_entity_name: match.full_name,
            }).eq("id", cl.id);
          }
        }
      } else if (entityId) {
        const table = entityType === "candidate" ? "candidates" : "contacts";
        const { data: e } = await supabase.from(table).select("full_name").eq("id", entityId).maybeSingle();
        entityName = e?.full_name ?? "candidate";
      }

      // ── Joe extraction (Claude Sonnet) ──────────────────────────
      const duration = `${Math.floor((cl.duration_seconds ?? 0) / 60)}m ${(cl.duration_seconds ?? 0) % 60}s`;
      let intel: Record<string, any> = {
        summary: `Call with ${entityName} (${duration}).`,
        action_items: "- Follow up manually",
      };

      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            system: `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from this ${duration} call with ${entityName}. Finance-aware, no fluff, but be thorough enough to be useful.

Return ONLY valid JSON in this exact shape:
{"summary":"...","action_items":"...","reason_for_leaving":null,"current_base":null,"current_bonus":null,"target_base":null,"target_bonus":null,"current_title":null,"current_company":null,"notes":null}

Field rules:
- summary: 4–8 sentences. Cover who they are, current situation, what they're looking for, and any notable signals (urgency, fit concerns, red flags). Strategic, not a transcript dump.
- action_items: bulleted list of concrete next steps for the recruiter. Use "- " prefix on each line. If genuinely none, return "- None".
- notes: free-form recruiter color — verbatim quotes worth remembering, soft signals, personality observations, blockers. Different from summary. Null only if there is genuinely nothing to add.
- reason_for_leaving: short phrase, null if not discussed.
- current_title / current_company: short strings, null if not stated.
- current_base, current_bonus, target_base, target_bonus: MUST be a single integer (annual USD, no commas, no currency symbol, no strings, no ranges). If a range is given (e.g. "160-170k"), return the midpoint as an integer (165000). If only a vague signal (e.g. "comfortable in the 200s"), return your best single-integer estimate. Null if not discussed at all.`,
            messages: [{ role: "user", content: `Transcript:\n${transcript.slice(0, 30000)}` }],
          }),
        });
        if (!resp.ok) throw new Error(`Claude ${resp.status}`);
        const data = await resp.json();
        intel = JSON.parse((data.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
      } catch (err: any) {
        logger.warn("Joe extraction failed", { error: err.message });
        stats.joe_error++;
        intel.summary = `Call with ${entityName} (${duration}). Transcript available.`;
      }

      // Coerce comp values to integers; drop strings/ranges Joe might still emit.
      const toInt = (v: any): number | null => {
        if (v == null) return null;
        if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
        if (typeof v === "string") {
          const nums = v.match(/\d[\d,]*/g);
          if (!nums?.length) return null;
          const parsed = nums.map((n) => parseInt(n.replace(/,/g, ""), 10)).filter(Number.isFinite);
          if (!parsed.length) return null;
          // If a range, take midpoint; else first value.
          const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
          return Math.round(avg);
        }
        return null;
      };
      intel.current_base = toInt(intel.current_base);
      intel.current_bonus = toInt(intel.current_bonus);
      intel.target_base = toInt(intel.target_base);
      intel.target_bonus = toInt(intel.target_bonus);

      // ── Write ai_call_notes ─────────────────────────────────────
      const now = new Date().toISOString();
      const { error: upsertErr } = await supabase.from("ai_call_notes").upsert({
        candidate_id: entityType === "candidate" ? entityId : null,
        contact_id: entityType === "contact" ? entityId : null,
        phone_number: cl.phone_number,
        source: "ringcentral",
        call_direction: cl.direction ?? "outbound",
        call_duration_seconds: cl.duration_seconds,
        call_duration_formatted: duration,
        transcript,
        transcription_provider: "deepgram",
        ai_summary: intel.summary,
        ai_action_items: intel.action_items,
        extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
        extracted_current_base: intel.current_base ?? null,
        extracted_current_bonus: intel.current_bonus ?? null,
        extracted_target_base: intel.target_base ?? null,
        extracted_target_bonus: intel.target_bonus ?? null,
        extracted_notes: intel.notes ?? null,
        recording_url: contentUri,
        processing_status: "completed",
        external_call_id: cl.external_call_id,
        owner_id: cl.owner_id,
        call_started_at: cl.started_at,
        call_ended_at: cl.ended_at,
        call_log_id: cl.id,
        created_at: now,
      } as any, { onConflict: "external_call_id", ignoreDuplicates: false });

      if (upsertErr) {
        logger.error("Upsert failed", { error: upsertErr.message });
        stats.insert_error++;
        continue;
      }

      // Update call_logs
      const clUpdate: Record<string, any> = { summary: intel.summary, updated_at: now };
      if (contentUri) clUpdate.audio_url = contentUri;
      if (entityId) { clUpdate.linked_entity_type = entityType; clUpdate.linked_entity_id = entityId; }
      await supabase.from("call_logs").update(clUpdate).eq("id", cl.id);

      // Update candidate fields
      if (entityType === "candidate" && entityId) {
        const updates: Record<string, any> = { updated_at: now, status: "back_of_resume" };
        if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
        if (intel.current_base) updates.current_base_comp = intel.current_base;
        if (intel.current_bonus) updates.current_bonus_comp = intel.current_bonus;
        if (intel.target_base) updates.target_base_comp = intel.target_base;
        if (intel.target_bonus) updates.target_bonus_comp = intel.target_bonus;
        if (intel.current_title) updates.current_title = intel.current_title;
        if (intel.current_company) updates.current_company = intel.current_company;
        if (intel.notes) updates.back_of_resume_notes = intel.notes;
        await supabase.from("candidates").update(updates).eq("id", entityId);
        logger.info("Updated candidate", { name: entityName });
      }

      logger.info("Processed", {
        call: cl.external_call_id,
        candidate: entityName,
        duration: cl.duration_seconds,
        transcriptChars: transcript.length,
        summary: intel.summary?.slice(0, 80),
      });
    }

    logger.info("Batch complete", stats);
    return stats;
  },
});

// ── Helpers ─────────────────────────────────────────────────────────
async function getRCToken(supabase: any, ownerId: string): Promise<string | null> {
  const { data } = await supabase.from("integration_accounts")
    .select("access_token, token_expires_at, rc_jwt, metadata")
    .eq("owner_user_id", ownerId).eq("provider", "sms").eq("is_active", true).maybeSingle();
  if (!data) return null;
  if (data.access_token && new Date(data.token_expires_at) > new Date(Date.now() + 60000)) {
    return data.access_token;
  }
  const meta = data.metadata ?? {};
  if (!data.rc_jwt || !meta.rc_client_id || !meta.rc_client_secret) return data.access_token ?? null;
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${meta.rc_client_id}:${meta.rc_client_secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: data.rc_jwt,
    }),
  });
  if (!r.ok) return data.access_token ?? null;
  const t = await r.json();
  await supabase.from("integration_accounts").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_user_id", ownerId).eq("provider", "sms");
  return t.access_token;
}

async function fetchCallsInRange(token: string, dateFrom: string, dateTo: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (page <= 30) {
    const params = new URLSearchParams({ type: "Voice", view: "Detailed", dateFrom, dateTo, perPage: "100", page: String(page) });
    const r = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) break;
    const d = await r.json();
    const records = d.records ?? [];
    all.push(...records);
    if (records.length < 100) break;
    page++;
  }
  return all;
}

function buildLookup(records: any[]): Map<string, any> {
  const m = new Map();
  for (const r of records) {
    if (r.id) m.set(String(r.id), r);
    if (r.sessionId) m.set(String(r.sessionId), r);
    if (r.telephonySessionId) m.set(String(r.telephonySessionId), r);
  }
  return m;
}
