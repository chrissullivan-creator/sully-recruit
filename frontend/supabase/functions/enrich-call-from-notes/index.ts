import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json();

  // Accept either call_log_id or ai_call_note_id, plus optional manual notes override
  const { call_log_id, ai_call_note_id, notes_override } = body;

  if (!call_log_id && !ai_call_note_id) {
    return respond({ error: "call_log_id or ai_call_note_id required" }, 400);
  }

  // Fetch the call and existing notes
  let call: any = null;
  let note: any = null;
  let candidate: any = null;

  if (call_log_id) {
    const { data } = await supabase
      .from("call_logs")
      .select("*, ai_call_notes!left(*), candidates!left(id, full_name, current_title, current_company, current_base_comp, current_bonus_comp, target_base_comp, target_bonus_comp, reason_for_leaving)")
      .eq("id", call_log_id)
      .maybeSingle();
    call = data;
    note = Array.isArray(data?.ai_call_notes) ? data.ai_call_notes[0] : data?.ai_call_notes;
    candidate = Array.isArray(data?.candidates) ? data.candidates[0] : data?.candidates;
  } else {
    const { data } = await supabase
      .from("ai_call_notes")
      .select("*, call_logs!left(*), candidates!left(id, full_name, current_title, current_company, current_base_comp, current_bonus_comp, target_base_comp, target_bonus_comp, reason_for_leaving)")
      .eq("id", ai_call_note_id)
      .maybeSingle();
    note = data;
    call = Array.isArray(data?.call_logs) ? data.call_logs[0] : data?.call_logs;
    candidate = Array.isArray(data?.candidates) ? data.candidates[0] : data?.candidates;
  }

  // Build the notes content to process — prefer manual override, then existing note fields, then call notes
  const notesContent = notes_override
    || note?.ai_summary
    || note?.extracted_notes
    || call?.notes
    || "";

  if (!notesContent || notesContent.includes("No transcript available") && !notes_override) {
    return respond({ error: "No notes content to process. Provide notes_override with the call summary." }, 400 );
  }

  const candidateName = candidate?.full_name ?? call?.linked_entity_name ?? "the candidate";
  const duration = call?.duration_seconds
    ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
    : "unknown duration";

  // Run through Joe
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: `You are Joe — AI backbone of Sully Recruit, a Wall Street recruiting firm. You're reading recruiter notes from a ${duration} call with ${candidateName}.

Extract every piece of structured recruiter intel from these notes. Be terse. Finance-aware. No fluff.

Return ONLY valid JSON, no markdown:
{
  "summary": "2-4 sentence punchy summary of the call. What happened, vibe, what's next.",
  "action_items": "Bulleted next steps, one per line starting with -",
  "reason_for_leaving": "Why they want to leave current role, or null",
  "current_base": null or number (USD annual, extract if mentioned),
  "current_bonus": null or number,
  "target_base": null or number,
  "target_bonus": null or number,
  "current_title": "Current job title if mentioned, or null",
  "current_company": "Current employer if mentioned, or null",
  "notes": "Key intel: notice period, restrictions, competing offers, red flags, timeline, open to relocate, preferences. Null if nothing notable."
}`,
      messages: [{ role: "user", content: notesContent }],
    }),
  });

  if (!res.ok) return respond({ error: `Claude ${res.status}` }, 500);
  const aiData = await res.json();

  let intel: any;
  try {
    intel = JSON.parse((aiData.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim());
  } catch {
    return respond({ error: "Failed to parse Joe response", raw: aiData.content?.[0]?.text }, 500);
  }

  const now = new Date().toISOString();

  // Update ai_call_notes with enriched data
  if (note?.id) {
    await supabase.from("ai_call_notes").update({
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: intel.reason_for_leaving,
      extracted_current_base: intel.current_base,
      extracted_current_bonus: intel.current_bonus,
      extracted_target_base: intel.target_base,
      extracted_target_bonus: intel.target_bonus,
      extracted_notes: intel.notes,
      processing_status: "completed",
      updated_candidates_at: now,
    }).eq("id", note.id);
  }

  // Update call_logs summary and notes
  if (call?.id) {
    await supabase.from("call_logs").update({
      summary: intel.summary,
      notes: notes_override
        ? `${notes_override}\n\n---\nJoe Summary:\n${intel.summary}\n\nAction items:\n${intel.action_items}`
        : `${intel.summary}\n\nAction items:\n${intel.action_items}${intel.notes ? `\n\nNotes:\n${intel.notes}` : ""}`,
      updated_at: now,
    }).eq("id", call.id);
  }

  // OVERWRITE candidate fields — call notes are the freshest data
  const candidateId = note?.candidate_id ?? call?.candidate_id;
  if (candidateId) {
    const updates: Record<string, any> = {
      status: "back_of_resume",
      updated_at: now,
    };
    if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
    if (intel.current_base) updates.current_base_comp = intel.current_base;
    if (intel.current_bonus) updates.current_bonus_comp = intel.current_bonus;
    if (intel.target_base) updates.target_base_comp = intel.target_base;
    if (intel.target_bonus) updates.target_bonus_comp = intel.target_bonus;
    if (intel.current_title) updates.current_title = intel.current_title;
    if (intel.current_company) updates.current_company = intel.current_company;
    if (intel.notes) updates.back_of_resume_notes = intel.notes;
    await supabase.from("candidates").update(updates).eq("id", candidateId);
  }

  return respond({
    ok: true,
    candidate_name: candidateName,
    candidate_updated: !!candidateId,
    intel,
  });
});
