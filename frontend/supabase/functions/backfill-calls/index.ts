import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  const forceAll = body.force_all === true; // reprocess even if notes exist
  const limitN = body.limit ?? 50;

  // Get calls to process:
  // - duration >= 30s
  // - has external_call_id
  // - not a missed/internal call
  // - either no ai_call_notes, OR force_all=true, OR notes have no real summary (stub)
  const { data: calls, error } = await supabase
    .from("call_logs")
    .select(`
      id, external_call_id, candidate_id, contact_id, owner_id,
      phone_number, direction, duration_seconds, started_at, ended_at,
      ai_call_notes!left(id, ai_summary, external_call_id)
    `)
    .gte("duration_seconds", 30)
    .not("external_call_id", "is", null)
    .not("notes", "eq", "Missed")
    .order("started_at", { ascending: false })
    .limit(limitN);

  if (error) return respond({ error: error.message }, 500);

  const toProcess = (calls ?? []).filter((c: any) => {
    const note = Array.isArray(c.ai_call_notes) ? c.ai_call_notes[0] : c.ai_call_notes;
    if (forceAll) return true;
    if (!note) return true; // no notes at all
    // Stub detection: summary just says "No transcript available"
    const isStub = !note.ai_summary || note.ai_summary.includes("No transcript available");
    return isStub;
  });

  console.log(`[backfill-calls] total=${calls?.length} to_process=${toProcess.length} force=${forceAll}`);

  const results: Record<string, unknown>[] = [];
  let processed = 0, skipped = 0, failed = 0;

  const baseUrl = SUPABASE_URL + "/functions/v1/process-call-recording";

  for (const call of toProcess) {
    try {
      // Rate limit: 1 call every 3 seconds to avoid hammering RC API
      if (processed > 0) await new Promise(r => setTimeout(r, 3000));

      const payload = {
        call_id: call.external_call_id,
        session_id: call.external_call_id,
        candidate_id: call.candidate_id ?? null,
        contact_id: call.contact_id ?? null,
        owner_id: call.owner_id,
        call_direction: call.direction,
        call_duration_seconds: call.duration_seconds,
        call_started_at: call.started_at,
        call_ended_at: call.ended_at,
        phone_number: call.phone_number,
      };

      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });

      const result = await res.json().catch(() => ({}));

      if (res.ok && result.success) {
        processed++;
        results.push({
          call_id: call.external_call_id,
          status: "processed",
          has_transcript: result.has_transcript,
          has_audio: result.has_audio,
          summary_preview: (result.summary ?? "").slice(0, 80),
        });
      } else if (result.skipped) {
        skipped++;
        results.push({ call_id: call.external_call_id, status: "skipped", reason: result.reason });
      } else {
        failed++;
        results.push({ call_id: call.external_call_id, status: "failed", error: result.error ?? `HTTP ${res.status}` });
      }
    } catch (err: any) {
      failed++;
      results.push({ call_id: call.external_call_id, status: "error", error: err.message });
    }
  }

  console.log(`[backfill-calls] done: processed=${processed} skipped=${skipped} failed=${failed}`);

  return respond({
    ok: true,
    total_eligible: calls?.length,
    to_process: toProcess.length,
    processed,
    skipped,
    failed,
    results,
  });
});
