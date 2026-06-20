import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RC_SERVER = "https://platform.ringcentral.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const respond = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function fmt(s: number) { return `${Math.floor(s / 60)}m ${s % 60}s`; }

async function getAppSetting(supabase: any, key: string): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// ── RC Token (refresh via JWT bearer) ──────────────────────────────
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
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${meta.rc_client_id}:${meta.rc_client_secret}`)}` },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: data.rc_jwt }),
  });
  if (!r.ok) { console.warn(`[token] refresh failed ${r.status}`); return data.access_token ?? null; }
  const t = await r.json();
  await supabase.from("integration_accounts").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_user_id", ownerId).eq("provider", "sms");
  return t.access_token;
}

// ── Bulk-fetch RC call-log by date range ───────────────────────────
async function fetchCallsInRange(token: string, dateFrom: string, dateTo: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (page <= 30) {
    const params = new URLSearchParams({ type: "Voice", view: "Detailed", dateFrom, dateTo, perPage: "100", page: String(page) });
    const r = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.warn(`[call-log] page ${page} failed: ${r.status}`); break; }
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

// ── RingSense insights (try first — free if it works) ────────────
async function fetchRingSenseInsights(recordingId: string, token: string): Promise<any | null> {
  const r = await fetch(
    `${RC_SERVER}/ai/ringsense/v1/public/accounts/~/domains/pbx/records/${recordingId}/insights`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(12000) },
  );
  if (!r.ok) {
    console.warn(`[ringsense] ${r.status} for ${recordingId}`);
    return null;
  }
  return await r.json();
}

// ── Deepgram Nova-3 transcription (fallback) ──────────────────
async function transcribeWithDeepgram(
  recordingContentUri: string,
  rcToken: string,
  deepgramKey: string,
): Promise<string | null> {
  // 1. Download audio from RingCentral
  console.log(`[deepgram] downloading recording...`);
  const audioResp = await fetch(recordingContentUri, {
    headers: { Authorization: `Bearer ${rcToken}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!audioResp.ok) {
    console.warn(`[deepgram] audio download failed: ${audioResp.status}`);
    return null;
  }
  const audioBytes = await audioResp.arrayBuffer();
  const contentType = audioResp.headers.get("content-type") || "audio/mpeg";
  console.log(`[deepgram] downloaded ${audioBytes.byteLength} bytes (${contentType})`);

  // 2. Send to Deepgram Nova-3 with speaker diarization
  const dgResp = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=en&punctuate=true&paragraphs=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": contentType,
      },
      body: audioBytes,
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!dgResp.ok) {
    const err = await dgResp.text().catch(() => "");
    console.warn(`[deepgram] transcription failed: ${dgResp.status} ${err.slice(0, 200)}`);
    return null;
  }

  const dg = await dgResp.json();

  // 3. Extract speaker-labeled transcript from paragraphs
  const paragraphs = dg.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs;
  if (paragraphs && paragraphs.length > 0) {
    const lines: string[] = [];
    for (const para of paragraphs) {
      const speaker = para.speaker === 0 ? "Recruiter" : `Speaker ${para.speaker + 1}`;
      const text = (para.sentences ?? []).map((s: any) => s.text).join(" ");
      if (text.trim()) lines.push(`${speaker}: ${text}`);
    }
    if (lines.length > 0) {
      console.log(`[deepgram] ✅ transcript: ${lines.length} paragraphs, ${lines.join("").length} chars`);
      return lines.join("\n");
    }
  }

  // Fallback: plain transcript without speakers
  const plain = dg.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (plain && plain.length > 20) {
    console.log(`[deepgram] ✅ plain transcript: ${plain.length} chars`);
    return plain;
  }

  console.warn(`[deepgram] no transcript in response`);
  return null;
}

// ── Joe extraction (Claude Sonnet) ────────────────────────────────
async function joeExtract(content: string, candidateName: string, duration: string): Promise<Record<string, any>> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from this ${duration} call with ${candidateName}. Finance-aware, terse, no fluff.\n\nReturn ONLY valid JSON:\n{"summary":"2-4 sentence punchy summary","action_items":"- bulleted next steps","reason_for_leaving":null,"current_base":null,"current_bonus":null,"target_base":null,"target_bonus":null,"current_title":null,"current_company":null,"notes":null}`,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const d = await r.json();
  return JSON.parse((d.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
}

// ── Main handler ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return respond({ error: "POST only" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  const batchSize = body.batch_size ?? 10;
  const dryRun = body.dry_run ?? false;

  // Get Deepgram API key from app_settings
  const deepgramKey = await getAppSetting(supabase, "DEEPGRAM_API_KEY");
  if (!deepgramKey && !dryRun) {
    console.warn("[main] No DEEPGRAM_API_KEY in app_settings — Deepgram transcription disabled");
  }

  // 1. Find un-noted call_logs
  const { data: eligible, error: qErr } = await supabase
    .from("call_logs")
    .select("id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id")
    .not("external_call_id", "is", null)
    .gte("duration_seconds", 30)
    .order("started_at", { ascending: false });

  if (qErr) return respond({ error: qErr.message }, 500);

  const ids = (eligible ?? []).map((c: any) => c.id);
  const { data: existingNotes } = await supabase
    .from("ai_call_notes").select("call_log_id").in("call_log_id", ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']);
  const noted = new Set((existingNotes ?? []).map((n: any) => n.call_log_id));
  const toProcess = (eligible ?? []).filter((c: any) => !noted.has(c.id)).slice(0, batchSize);

  if (!toProcess.length) return respond({ ok: true, message: "No un-noted calls to process" });

  // 2. Get RC tokens per owner
  const owners = [...new Set(toProcess.map((c: any) => c.owner_id))];
  const tokens: Record<string, string> = {};
  for (const ownerId of owners) {
    const t = await getRCToken(supabase, ownerId);
    if (t) tokens[ownerId] = t;
  }

  // 3. Bulk-fetch call-log per owner
  const lookups: Record<string, Map<string, any>> = {};
  for (const ownerId of owners) {
    const token = tokens[ownerId];
    if (!token) continue;
    const ownerCalls = toProcess.filter((c: any) => c.owner_id === ownerId);
    const sorted = ownerCalls.slice().sort((a: any, b: any) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    const dateFrom = new Date(new Date(sorted[0].started_at).getTime() - 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const dateTo = new Date(new Date(sorted[sorted.length - 1].started_at).getTime() + 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const records = await fetchCallsInRange(token, dateFrom, dateTo);
    lookups[ownerId] = buildLookup(records);
    console.log(`[main] lookup ${ownerId}: ${records.length} records, ${lookups[ownerId].size} keys`);
  }

  // 4. Process each call
  const stats = { total: toProcess.length, processed: 0, notes_created: 0, no_rc_match: 0, no_recording: 0, transcribed_deepgram: 0, transcribed_ringsense: 0, no_transcript: 0, joe_error: 0, insert_error: 0, dry_run_ready: 0 };
  const results: any[] = [];

  for (const cl of toProcess) {
    stats.processed++;
    const token = tokens[cl.owner_id];
    if (!token) { stats.no_rc_match++; continue; }

    const lookup = lookups[cl.owner_id];
    const rcRecord = lookup?.get(String(cl.external_call_id));
    if (!rcRecord) { stats.no_rc_match++; continue; }

    let recordingId = rcRecord.recording?.id;
    if (!recordingId) {
      for (const leg of rcRecord.legs ?? []) {
        if (leg.recording?.id) { recordingId = leg.recording.id; break; }
      }
    }
    const recordingContentUri = rcRecord.recording?.contentUri ?? rcRecord.legs?.[0]?.recording?.contentUri ?? null;

    if (!recordingId || !recordingContentUri) { stats.no_recording++; continue; }

    if (dryRun) {
      stats.dry_run_ready++;
      results.push({ call_id: cl.external_call_id, recording_id: recordingId, status: "dry_run_ready" });
      continue;
    }

    // ── Transcription: try RingSense first, fall back to Deepgram ──
    let transcript: string | null = null;
    let transcriptionSource = "none";
    let ringSenseSummary: string | null = null;
    let keyPoints: string[] = [];
    let actionItems: string[] = [];

    await new Promise(r => setTimeout(r, 500)); // rate limit

    // Try RingSense
    const insights = await fetchRingSenseInsights(String(recordingId), token);
    if (insights) {
      const insightMap = insights.insights ?? insights;
      const txInsight = Array.isArray(insightMap) ? insightMap.find((i: any) => i.type === "Transcript" || i.name === "Transcript") : insightMap?.Transcript;
      if (txInsight) {
        if (Array.isArray(txInsight.values ?? txInsight.utterances)) {
          transcript = (txInsight.values ?? txInsight.utterances).map((u: any) => `${u.speakerName ?? u.speaker ?? 'Speaker'}: ${u.text ?? u.value ?? ''}`).join("\n");
        } else if (txInsight.text) { transcript = txInsight.text; }
      }
      const sumInsight = Array.isArray(insightMap) ? insightMap.find((i: any) => i.type === "Summary") : insightMap?.Summary;
      if (sumInsight) ringSenseSummary = typeof sumInsight === "string" ? sumInsight : (sumInsight.text ?? sumInsight.value ?? null);
      const hlInsight = Array.isArray(insightMap) ? insightMap.find((i: any) => i.type === "HighLights") : insightMap?.HighLights;
      if (hlInsight?.values) keyPoints = hlInsight.values.map((v: any) => typeof v === "string" ? v : v.text ?? "");
      const nsInsight = Array.isArray(insightMap) ? insightMap.find((i: any) => i.type === "NextSteps") : insightMap?.NextSteps;
      if (nsInsight?.values) actionItems = nsInsight.values.map((v: any) => typeof v === "string" ? v : v.text ?? "");
      if (transcript) {
        transcriptionSource = "ringsense";
        stats.transcribed_ringsense++;
        console.log(`[main] ✅ RingSense transcript for ${cl.external_call_id}`);
      }
    }

    // Fall back to Deepgram if no RingSense transcript
    if (!transcript && deepgramKey) {
      console.log(`[main] trying Deepgram for ${cl.external_call_id} (${fmt(cl.duration_seconds)})`);
      transcript = await transcribeWithDeepgram(recordingContentUri, token, deepgramKey);
      if (transcript) {
        transcriptionSource = "deepgram";
        stats.transcribed_deepgram++;
      }
    }

    if (!transcript) {
      stats.no_transcript++;
    }

    // ── Entity matching ──
    let entityId = cl.linked_entity_id;
    let entityType = cl.linked_entity_type;
    let entityName = "candidate";

    if (!entityId && cl.phone_number) {
      const last10 = cl.phone_number.replace(/\D/g, "").slice(-10);
      if (last10.length === 10) {
        const { data: cands } = await supabase.from("candidates").select("id, full_name, phone").not("phone", "is", null);
        const match = (cands ?? []).find((c: any) => c.phone && c.phone.replace(/\D/g, "").slice(-10) === last10);
        if (match) {
          entityId = match.id; entityType = "candidate"; entityName = match.full_name;
          await supabase.from("call_logs").update({ linked_entity_type: "candidate", linked_entity_id: match.id, linked_entity_name: match.full_name }).eq("id", cl.id);
        } else {
          const { data: conts } = await supabase.from("contacts").select("id, full_name, phone").not("phone", "is", null);
          const cmatch = (conts ?? []).find((c: any) => c.phone && c.phone.replace(/\D/g, "").slice(-10) === last10);
          if (cmatch) {
            entityId = cmatch.id; entityType = "contact"; entityName = cmatch.full_name;
            await supabase.from("call_logs").update({ linked_entity_type: "contact", linked_entity_id: cmatch.id, linked_entity_name: cmatch.full_name }).eq("id", cl.id);
          }
        }
      }
    } else if (entityId) {
      const table = entityType === "candidate" ? "candidates" : "contacts";
      const { data: e } = await supabase.from(table).select("full_name").eq("id", entityId).maybeSingle();
      entityName = e?.full_name ?? "candidate";
    }

    // ── Joe extraction ──
    const hasContent = !!(ringSenseSummary || transcript);
    const context = [
      ringSenseSummary ? `RingSense Summary: ${ringSenseSummary}` : null,
      keyPoints.length ? `Key Points:\n${keyPoints.map(k => `- ${k}`).join("\n")}` : null,
      actionItems.length ? `Action Items:\n${actionItems.map(a => `- ${a}`).join("\n")}` : null,
      transcript ? `Transcript:\n${transcript.slice(0, 10000)}` : null,
    ].filter(Boolean).join("\n\n");

    const duration = fmt(cl.duration_seconds ?? 0);
    let intel: Record<string, any> = {
      summary: ringSenseSummary ?? `Call with ${entityName} (${duration}). Audio available.`,
      action_items: actionItems.length ? actionItems.map(a => `- ${a}`).join("\n") : "- Follow up manually",
    };

    if (hasContent && context.length > 20) {
      try {
        intel = await joeExtract(context, entityName, duration);
      } catch (e) {
        console.warn(`[main] Joe failed: ${(e as Error).message}`);
        stats.joe_error++;
      }
    }

    const now = new Date().toISOString();

    // ── Write ai_call_notes ──
    const { error: upsertErr } = await supabase.from("ai_call_notes").upsert({
      candidate_id: entityType === "candidate" ? entityId : null,
      contact_id: entityType === "contact" ? entityId : null,
      phone_number: cl.phone_number,
      source: "ringcentral",
      call_direction: cl.direction ?? "outbound",
      call_duration_seconds: cl.duration_seconds,
      call_duration_formatted: duration,
      transcript,
      transcription_provider: transcriptionSource,
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
      extracted_current_base: intel.current_base ?? null,
      extracted_current_bonus: intel.current_bonus ?? null,
      extracted_target_base: intel.target_base ?? null,
      extracted_target_bonus: intel.target_bonus ?? null,
      extracted_notes: intel.notes ?? null,
      recording_url: recordingContentUri,
      processing_status: hasContent ? "completed" : "audio_only",
      external_call_id: cl.external_call_id,
      owner_id: cl.owner_id,
      call_started_at: cl.started_at,
      call_ended_at: cl.ended_at,
      call_log_id: cl.id,
      created_at: now,
    }, { onConflict: "external_call_id", ignoreDuplicates: false });

    if (upsertErr) { console.error(`[main] upsert: ${upsertErr.message}`); stats.insert_error++; continue; }

    // Update call_logs
    const clUpdate: Record<string, any> = { summary: intel.summary, updated_at: now };
    if (recordingContentUri) clUpdate.audio_url = recordingContentUri;
    if (entityId && entityType) { clUpdate.linked_entity_type = entityType; clUpdate.linked_entity_id = entityId; }
    await supabase.from("call_logs").update(clUpdate).eq("id", cl.id);

    // Update candidate fields
    if (entityType === "candidate" && entityId && hasContent) {
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
    }

    stats.notes_created++;
    results.push({
      call_id: cl.external_call_id, recording_id: recordingId, candidate: entityName,
      has_transcript: !!transcript, transcription_source: transcriptionSource,
      summary_preview: (intel.summary ?? "").slice(0, 80), status: "processed",
    });
  }

  console.log("[main] done", JSON.stringify(stats));
  return respond({ ok: true, ...stats, results });
});
