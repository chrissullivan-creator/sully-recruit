import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VOYAGE_MODEL = "voyage-finance-2";
const RC_SERVER = "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function getRCToken(supabase: any, ownerId: string): Promise<string | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("access_token, refresh_token, token_expires_at, rc_jwt, metadata")
    .eq("owner_user_id", ownerId)
    .eq("provider", "sms")
    .eq("is_active", true)
    .maybeSingle();
  if (!data) return null;
  if (data.access_token && new Date(data.token_expires_at) > new Date(Date.now() + 60000)) return data.access_token;
  const meta = data.metadata ?? {};
  const { client_id: clientId, client_secret: clientSecret } = meta;
  const jwt = data.rc_jwt;
  if (!clientId || !clientSecret || !jwt) return data.access_token ?? null;
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) return data.access_token ?? null;
  const token = await res.json();
  await supabase.from("integration_accounts").update({
    access_token: token.access_token,
    token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_user_id", ownerId).eq("provider", "sms");
  return token.access_token;
}

interface RingSenseData {
  transcript: string | null;
  ringSenseSummary: string | null;
  keyPoints: string[];
  actionItems: string[];
  duration: number;
  recordingUrl: string | null;
}

async function fetchRingSenseData(callId: string, sessionId: string, accessToken: string): Promise<RingSenseData> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  let transcript: string | null = null;
  let ringSenseSummary: string | null = null;
  let keyPoints: string[] = [];
  let actionItems: string[] = [];
  let duration = 0;
  let recordingUrl: string | null = null;

  try {
    const txRes = await fetch(`${RC_SERVER}/ai/audio/v1/async/speech-to-text/${callId}`, { headers, signal: AbortSignal.timeout(15000) });
    if (txRes.ok) {
      const tx = await txRes.json();
      if (Array.isArray(tx.utterances) && tx.utterances.length > 0) {
        transcript = tx.utterances.map((u: any) => `${u.speakerName ?? `Speaker ${u.speakerId}`}: ${u.text}`).join("\n");
        duration = tx.duration ?? 0;
      } else if (tx.text) { transcript = tx.text; }
    }
  } catch (e) { console.warn("[process-call] stt failed:", (e as Error).message); }

  try {
    const aiRes = await fetch(`${RC_SERVER}/ai/audio/v1/async/analyze-interaction/${callId}`, { headers, signal: AbortSignal.timeout(15000) });
    if (aiRes.ok) {
      const ai = await aiRes.json();
      ringSenseSummary = ai.summary ?? ai.brief ?? null;
      keyPoints = Array.isArray(ai.keyPoints) ? ai.keyPoints : [];
      actionItems = Array.isArray(ai.actionItems) ? ai.actionItems.map((a: any) => typeof a === "string" ? a : a.text ?? JSON.stringify(a)) : [];
    }
  } catch (e) { console.warn("[process-call] analyze-interaction failed:", (e as Error).message); }

  try {
    const logRes = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/call-log?sessionId=${sessionId}&view=Detailed`, { headers, signal: AbortSignal.timeout(10000) });
    if (logRes.ok) {
      const log = await logRes.json();
      const record = log.records?.[0];
      if (record) {
        if (!duration) duration = record.duration ?? 0;
        if (!ringSenseSummary && record.aiNotes?.summary) ringSenseSummary = record.aiNotes.summary;
        if (!transcript && record.aiNotes?.transcription) transcript = record.aiNotes.transcription;
        const recId = record.recordings?.[0]?.id;
        if (recId) {
          const recRes = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/recording/${recId}/content`, { headers });
          if (recRes.ok) recordingUrl = recRes.url;
        }
      }
    }
  } catch (e) { console.warn("[process-call] call-log fallback failed:", (e as Error).message); }

  return { transcript, ringSenseSummary, keyPoints, actionItems, duration, recordingUrl };
}

async function extractIntelWithJoe(params: {
  transcript: string | null;
  ringSenseSummary: string | null;
  keyPoints: string[];
  actionItems: string[];
  candidateName: string | null;
  recruiterName: string | null;
  duration: number;
}): Promise<{
  summary: string;
  action_items: string;
  reason_for_leaving: string | null;
  current_base: number | null;
  current_bonus: number | null;
  target_base: number | null;
  target_bonus: number | null;
  notes: string | null;
  current_title: string | null;
  current_company: string | null;
}> {
  const context = [
    params.ringSenseSummary ? `RingSense Summary: ${params.ringSenseSummary}` : null,
    params.keyPoints.length ? `Key Points:\n${params.keyPoints.map(k => `- ${k}`).join("\n")}` : null,
    params.actionItems.length ? `RingSense Action Items:\n${params.actionItems.map(a => `- ${a}`).join("\n")}` : null,
    params.transcript ? `Full Transcript:\n${params.transcript.slice(0, 12000)}` : null,
  ].filter(Boolean).join("\n\n");

  if (!context.trim()) {
    return {
      summary: `Call with ${params.candidateName ?? "candidate"} (${formatDuration(params.duration)}). No transcript available from RingSense.`,
      action_items: "- Follow up manually",
      reason_for_leaving: null, current_base: null, current_bonus: null,
      target_base: null, target_bonus: null, notes: null,
      current_title: null, current_company: null,
    };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: `You are Joe — AI backbone of Sully Recruit, a Wall Street recruiting firm. You're reading a call between ${params.recruiterName ?? "an Emerald recruiter"} and ${params.candidateName ?? "a candidate or contact"}.

Extract recruiter-specific intel: comp data, reason for leaving, red flags, competing offers, notice period, title/company, timeline. Be terse. Finance-aware. No fluff.

Return ONLY valid JSON, no markdown:
{
  "summary": "2-4 sentence punchy summary. What happened, vibe, what's next.",
  "action_items": "Bulleted next steps, one per line starting with -",
  "reason_for_leaving": "Why they want to leave current role, or null",
  "current_base": null or number (USD annual),
  "current_bonus": null or number,
  "target_base": null or number,
  "target_bonus": null or number,
  "current_title": "Current job title if mentioned, or null",
  "current_company": "Current employer if mentioned, or null",
  "notes": "Key intel: restrictions, notice period, competing offers, red flags, timing. Null if nothing notable."
}`,
      messages: [{ role: "user", content: context }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  return JSON.parse((data.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}`);
  return (await res.json()).data[0].embedding;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const { call_id, session_id, candidate_id, contact_id, owner_id, call_direction, call_duration_seconds, call_started_at, call_ended_at, phone_number } = body;

    if (!call_id && !session_id) return respond({ error: "call_id or session_id required" }, 400);
    if (!owner_id) return respond({ error: "owner_id required" }, 400);
    if (call_duration_seconds && call_duration_seconds < 30) {
      return respond({ ok: true, skipped: true, reason: "call_too_short", duration: call_duration_seconds });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const accessToken = await getRCToken(supabase, owner_id);
    if (!accessToken) return respond({ error: "No RingCentral access token" }, 422);

    const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", owner_id).maybeSingle();
    const recruiterName = profile?.full_name ?? null;

    let entityName: string | null = null;
    if (candidate_id) {
      const { data } = await supabase.from("candidates").select("full_name").eq("id", candidate_id).maybeSingle();
      entityName = data?.full_name ?? null;
    } else if (contact_id) {
      const { data } = await supabase.from("contacts").select("full_name").eq("id", contact_id).maybeSingle();
      entityName = data?.full_name ?? null;
    }

    console.log(`[process-call] ${entityName ?? phone_number ?? "unknown"} call=${call_id}`);
    await new Promise(r => setTimeout(r, 5000));

    const ringSense = await fetchRingSenseData(call_id ?? session_id, session_id ?? call_id, accessToken);
    const duration = call_duration_seconds ?? ringSense.duration;
    const intel = await extractIntelWithJoe({ ...ringSense, candidateName: entityName, recruiterName, duration });

    const embedText = [
      entityName ? `Candidate: ${entityName}` : "",
      `Summary: ${intel.summary}`,
      intel.reason_for_leaving ? `Reason for leaving: ${intel.reason_for_leaving}` : "",
      intel.notes ? `Notes: ${intel.notes}` : "",
      ringSense.transcript ? `Transcript: ${ringSense.transcript.slice(0, 3000)}` : "",
    ].filter(Boolean).join("\n");

    let embedding: number[] | null = null;
    try { embedding = await getEmbedding(embedText); } catch { /* non-fatal */ }

    const now = new Date().toISOString();

    // Upsert ai_call_notes — OVERWRITE existing if same call_id
    const { data: note, error: upsertErr } = await supabase.from("ai_call_notes").upsert({
      candidate_id: candidate_id ?? null,
      contact_id: contact_id ?? null,
      phone_number: phone_number ?? null,
      source: "ringcentral",
      call_direction: call_direction ?? "outbound",
      call_duration_seconds: duration,
      call_duration_formatted: formatDuration(duration),
      transcript: ringSense.transcript,
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: intel.reason_for_leaving,
      extracted_current_base: intel.current_base,
      extracted_current_bonus: intel.current_bonus,
      extracted_target_base: intel.target_base,
      extracted_target_bonus: intel.target_bonus,
      extracted_notes: intel.notes,
      recording_url: ringSense.recordingUrl,
      embedding: embedding ? JSON.stringify(embedding) : null,
      transcription_provider: "ringsense",
      processing_status: "completed",
      external_call_id: call_id ?? null,
      owner_id: owner_id ?? null,
      call_started_at: call_started_at ?? null,
      call_ended_at: call_ended_at ?? null,
      updated_candidates_at: now,
      created_at: now,
    }, { onConflict: "external_call_id", ignoreDuplicates: false }).select("id").single();

    if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);

    // Sync back to call_logs
    if (call_id) {
      const callLogUpdate: Record<string, any> = {
        summary: intel.summary,
        notes: `${intel.summary}\n\nAction items:\n${intel.action_items}${intel.notes ? `\n\nNotes:\n${intel.notes}` : ""}`,
        updated_at: now,
      };
      if (candidate_id) { callLogUpdate.candidate_id = candidate_id; callLogUpdate.linked_entity_type = "candidate"; callLogUpdate.linked_entity_id = candidate_id; }
      if (contact_id) { callLogUpdate.contact_id = contact_id; callLogUpdate.linked_entity_type = "contact"; callLogUpdate.linked_entity_id = contact_id; }
      if (ringSense.recordingUrl) callLogUpdate.audio_url = ringSense.recordingUrl;
      await supabase.from("call_logs").update(callLogUpdate).eq("external_call_id", call_id);
    }

    // ALWAYS overwrite candidate fields — call notes are the freshest data
    if (candidate_id) {
      const updates: Record<string, any> = { last_spoken_at: now, updated_at: now, status: "back_of_resume" };
      if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
      if (intel.current_base) updates.current_base_comp = intel.current_base;
      if (intel.current_bonus) updates.current_bonus_comp = intel.current_bonus;
      if (intel.target_base) updates.target_base_comp = intel.target_base;
      if (intel.target_bonus) updates.target_bonus_comp = intel.target_bonus;
      if (intel.current_title) updates.current_title = intel.current_title;
      if (intel.current_company) updates.current_company = intel.current_company;
      if (intel.notes) updates.back_of_resume_notes = intel.notes;
      await supabase.from("candidates").update(updates).eq("id", candidate_id);
      console.log(`[process-call] updated ${entityName} → back_of_resume`);
    }

    // Log to messages for unified inbox (overwrite if same call)
    if (call_id) {
      await supabase.from("messages").delete().eq("provider_message_id", call_id);
    }
    if (candidate_id || contact_id) {
      await supabase.from("messages").insert({
        candidate_id: candidate_id ?? null,
        contact_id: contact_id ?? null,
        channel: "call",
        direction: call_direction ?? "outbound",
        body: `📞 Call (${formatDuration(duration)})\n\n${intel.summary}\n\nNext steps:\n${intel.action_items}`,
        sent_at: call_ended_at ?? now,
        provider_message_id: call_id ?? null,
        is_read: true,
        conversation_id: crypto.randomUUID(),
        created_at: now, updated_at: now, inserted_at: now,
      });
    }

    console.log(`[process-call] ✅ ${entityName ?? "unknown"} | ${formatDuration(duration)} | transcript=${!!ringSense.transcript} | audio=${!!ringSense.recordingUrl}`);

    return respond({
      success: true,
      call_note_id: note?.id,
      duration: formatDuration(duration),
      has_transcript: !!ringSense.transcript,
      has_audio: !!ringSense.recordingUrl,
      candidate_updated: !!candidate_id,
      status_set: candidate_id ? "back_of_resume" : null,
      summary: intel.summary,
    });

  } catch (err: any) {
    console.error("[process-call] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
