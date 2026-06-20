import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Use env vars directly — same pattern as run-sequences for SMS
const RC_CLIENT_ID = Deno.env.get("RC_CLIENT_ID") ?? "";
const RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") ?? "";
const RC_SERVER = Deno.env.get("RC_SERVER") ?? "https://platform.ringcentral.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function fmt(s: number) { return `${Math.floor(s / 60)}m ${s % 60}s`; }

async function getRCToken(supabase: any, ownerId: string): Promise<string | null> {
  // Get the RC JWT from integration_accounts
  const { data } = await supabase.from("integration_accounts")
    .select("access_token, token_expires_at, rc_jwt")
    .eq("owner_user_id", ownerId).eq("provider", "sms").eq("is_active", true).maybeSingle();
  if (!data) return null;

  // Return valid token if not expired
  if (data.access_token && new Date(data.token_expires_at) > new Date(Date.now() + 60000)) {
    return data.access_token;
  }

  // Refresh using env var credentials + JWT from DB (same as run-sequences)
  if (!data.rc_jwt || !RC_CLIENT_ID || !RC_CLIENT_SECRET) {
    console.warn(`[getRCToken] missing jwt=${!!data.rc_jwt} clientId=${!!RC_CLIENT_ID}`);
    return data.access_token ?? null;
  }

  const creds = btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`);
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: data.rc_jwt }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn(`[getRCToken] refresh failed ${r.status}: ${err.slice(0, 200)}`);
    return data.access_token ?? null;
  }
  const t = await r.json();
  await supabase.from("integration_accounts").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_user_id", ownerId).eq("provider", "sms");
  console.log(`[getRCToken] refreshed OK, expires_in=${t.expires_in}`);
  return t.access_token;
}

async function fetchCallData(sessionId: string, callId: string, token: string) {
  const h = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let recordingContentUri: string | null = null;
  let ringSenseSummary: string | null = null;
  let transcript: string | null = null;
  let keyPoints: string[] = [];
  let actionItems: string[] = [];
  let duration = 0;

  try {
    const url = `${RC_SERVER}/restapi/v1.0/account/~/call-log?sessionId=${sessionId}&view=Detailed&withRecording=true`;
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(12000) });
    console.log(`[fetchCallData] session=${sessionId} status=${r.status}`);
    if (r.ok) {
      const d = await r.json();
      for (const rec of d.records ?? []) {
        if (!duration) duration = rec.duration ?? 0;
        if (rec.recording?.contentUri && !recordingContentUri) {
          recordingContentUri = rec.recording.contentUri;
          console.log(`[fetchCallData] ✅ got recording URL`);
        }
        // Check legs too
        for (const leg of rec.legs ?? []) {
          if (leg.recording?.contentUri && !recordingContentUri) {
            recordingContentUri = leg.recording.contentUri;
          }
        }
        const ai = rec.aiNotes ?? rec.ringSense ?? rec.aiInsights ?? null;
        if (ai && !ringSenseSummary) {
          ringSenseSummary = ai.summary ?? ai.brief ?? null;
          keyPoints = Array.isArray(ai.keyPoints) ? ai.keyPoints : [];
          actionItems = Array.isArray(ai.actionItems) ? ai.actionItems.map((a: any) => typeof a === "string" ? a : a.text ?? "") : [];
          transcript = ai.transcription ?? ai.transcript ?? null;
          if (ringSenseSummary) console.log(`[fetchCallData] ✅ got RingSense summary`);
        }
      }
    } else {
      const err = await r.text();
      console.warn(`[fetchCallData] call-log failed: ${err.slice(0, 200)}`);
    }
  } catch (e) { console.warn("call-log:", (e as Error).message); }

  if (!ringSenseSummary) {
    try {
      const r = await fetch(`${RC_SERVER}/ai/audio/v1/async/analyze-interaction/${callId}`, { headers: h, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        ringSenseSummary = d.summary ?? d.brief ?? null;
        keyPoints = Array.isArray(d.keyPoints) ? d.keyPoints : [];
        actionItems = Array.isArray(d.actionItems) ? d.actionItems.map((a: any) => typeof a === "string" ? a : a.text ?? "") : [];
        if (ringSenseSummary) console.log(`[fetchCallData] ✅ got analyze-interaction summary`);
      }
    } catch (e) { console.warn("analyze-interaction:", (e as Error).message); }
  }

  if (!transcript) {
    try {
      const r = await fetch(`${RC_SERVER}/ai/audio/v1/async/speech-to-text/${callId}`, { headers: h, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.utterances) && d.utterances.length > 0) {
          transcript = d.utterances.map((u: any) => `${u.speakerName ?? `Speaker ${u.speakerId}`}: ${u.text}`).join("\n");
          console.log(`[fetchCallData] ✅ got transcript ${d.utterances.length} utterances`);
        } else if (d.text) transcript = d.text;
      }
    } catch (e) { console.warn("stt:", (e as Error).message); }
  }

  return { recordingContentUri, ringSenseSummary, transcript, keyPoints, actionItems, duration };
}

async function joeExtract(content: string, candidateName: string, duration: string): Promise<Record<string, any>> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from this ${duration} call with ${candidateName}. Finance-aware, terse, no fluff.

Return ONLY valid JSON:
{"summary":"2-4 sentence punchy summary","action_items":"- bulleted next steps","reason_for_leaving":null,"current_base":null,"current_bonus":null,"target_base":null,"target_bonus":null,"current_title":null,"current_company":null,"notes":null}`,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const d = await r.json();
  return JSON.parse((d.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  const batchSize = body.batch_size ?? 20;

  const { data: queue } = await supabase
    .from("call_processing_queue")
    .select("call_id, session_id, candidate_id, contact_id, owner_id, duration_seconds, call_started_at, call_ended_at, phone_number, call_direction")
    .gte("duration_seconds", 30)
    .not("session_id", "is", null)
    .order("call_started_at", { ascending: false })
    .limit(batchSize);

  if (!queue?.length) return respond({ ok: true, message: "Nothing to process" });

  const ownerId = queue[0].owner_id;
  const token = await getRCToken(supabase, ownerId);
  if (!token) return respond({ error: "No RC token — check RC_CLIENT_ID/RC_CLIENT_SECRET env vars" }, 422);

  console.log(`[backfill] processing ${queue.length} calls, token=${token.slice(0, 10)}...`);

  const results: Record<string, any>[] = [];
  let gotRecording = 0, gotRingSense = 0, nothingFound = 0;

  for (const item of queue) {
    await new Promise(r => setTimeout(r, 1500));

    const callData = await fetchCallData(item.session_id, item.call_id, token);
    const hasAnything = !!(callData.recordingContentUri || callData.ringSenseSummary || callData.transcript);

    if (!hasAnything) {
      nothingFound++;
      results.push({ call_id: item.call_id, status: "no_data" });
      continue;
    }

    let candidateName = "candidate";
    if (item.candidate_id) {
      const { data: c } = await supabase.from("candidates").select("full_name").eq("id", item.candidate_id).maybeSingle();
      candidateName = c?.full_name ?? "candidate";
    }

    const duration = fmt(item.duration_seconds ?? callData.duration ?? 0);
    const content = [
      callData.ringSenseSummary ? `RingSense Summary: ${callData.ringSenseSummary}` : null,
      callData.keyPoints.length ? `Key Points:\n${callData.keyPoints.map((k: string) => `- ${k}`).join("\n")}` : null,
      callData.actionItems.length ? `Action Items:\n${callData.actionItems.map((a: string) => `- ${a}`).join("\n")}` : null,
      callData.transcript ? `Transcript:\n${callData.transcript.slice(0, 8000)}` : null,
    ].filter(Boolean).join("\n\n");

    let intel: Record<string, any> = {
      summary: callData.ringSenseSummary ?? `Call with ${candidateName} (${duration}). Audio available.`,
      action_items: "- Listen to recording and add notes",
    };
    if (content) {
      try { intel = await joeExtract(content, candidateName, duration); } catch (e) { console.warn("Joe:", e); }
    }

    const now = new Date().toISOString();

    await supabase.from("ai_call_notes").upsert({
      candidate_id: item.candidate_id ?? null,
      contact_id: item.contact_id ?? null,
      phone_number: item.phone_number ?? null,
      source: "ringcentral",
      call_direction: item.call_direction ?? "outbound",
      call_duration_seconds: item.duration_seconds,
      call_duration_formatted: duration,
      transcript: callData.transcript,
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
      extracted_current_base: intel.current_base ?? null,
      extracted_current_bonus: intel.current_bonus ?? null,
      extracted_target_base: intel.target_base ?? null,
      extracted_target_bonus: intel.target_bonus ?? null,
      extracted_notes: intel.notes ?? null,
      recording_url: callData.recordingContentUri,
      processing_status: content ? "completed" : "audio_only",
      external_call_id: item.call_id,
      owner_id: ownerId,
      call_started_at: item.call_started_at,
      call_ended_at: item.call_ended_at,
      created_at: now,
    }, { onConflict: "external_call_id", ignoreDuplicates: false });

    if (callData.recordingContentUri) {
      await supabase.from("call_logs").update({
        audio_url: callData.recordingContentUri,
        summary: intel.summary,
        updated_at: now,
      }).eq("external_call_id", item.call_id);
      gotRecording++;
    }
    if (callData.ringSenseSummary) gotRingSense++;

    if (item.candidate_id && content) {
      const updates: Record<string, any> = { updated_at: now, status: "back_of_resume" };
      if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
      if (intel.current_base) updates.current_base_comp = intel.current_base;
      if (intel.current_bonus) updates.current_bonus_comp = intel.current_bonus;
      if (intel.target_base) updates.target_base_comp = intel.target_base;
      if (intel.target_bonus) updates.target_bonus_comp = intel.target_bonus;
      if (intel.current_title) updates.current_title = intel.current_title;
      if (intel.current_company) updates.current_company = intel.current_company;
      if (intel.notes) updates.back_of_resume_notes = intel.notes;
      await supabase.from("candidates").update(updates).eq("id", item.candidate_id);
    }

    results.push({
      call_id: item.call_id, candidate: candidateName, status: "processed",
      has_recording: !!callData.recordingContentUri,
      has_ringsense: !!callData.ringSenseSummary,
      has_transcript: !!callData.transcript,
      summary_preview: (intel.summary ?? "").slice(0, 80),
    });
  }

  return respond({ ok: true, total: queue.length, got_recording: gotRecording, got_ringsense: gotRingSense, nothing_found: nothingFound, results });
});
