import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const batch_size = body.batch_size ?? 5;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Grab next batch of pending calls, avoid ones already being processed
    const { data: batch, error } = await supabase
      .from("call_processing_queue")
      .select("*")
      .eq("status", "pending")
      .lt("attempts", 3)  // max 3 tries
      .order("created_at", { ascending: true })
      .limit(batch_size);

    if (error) return respond({ error: error.message }, 500);
    if (!batch?.length) return respond({ message: "Queue empty 🎉", processed: 0 });

    // Mark as processing
    const ids = batch.map((r: any) => r.id);
    await supabase.from("call_processing_queue")
      .update({ status: "processing", attempts: supabase.rpc("coalesce", {}), updated_at: new Date().toISOString() })
      .in("id", ids);

    // Actually just increment attempts via raw SQL
    await supabase.from("call_processing_queue")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .in("id", ids);

    let processed = 0, failed = 0;

    // Fire each call through process-call-recording (fire and forget in parallel)
    const promises = batch.map(async (item: any) => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/process-call-recording`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            call_id: item.call_id,
            session_id: item.session_id,
            candidate_id: item.candidate_id,
            contact_id: item.contact_id,
            owner_id: item.owner_id,
            call_direction: item.call_direction,
            call_duration_seconds: item.duration_seconds,
            call_started_at: item.call_started_at,
            call_ended_at: item.call_ended_at,
            phone_number: item.phone_number,
          }),
          signal: AbortSignal.timeout(90000),
        });

        const result = await res.json();

        if (result.skipped || result.success) {
          await supabase.from("call_processing_queue")
            .update({ status: "done", updated_at: new Date().toISOString() })
            .eq("id", item.id);
          processed++;
        } else {
          throw new Error(result.error ?? "Unknown error");
        }
      } catch (err: any) {
        console.error(`[drain-call-queue] failed ${item.call_id}:`, err?.message);
        await supabase.from("call_processing_queue")
          .update({
            status: item.attempts >= 2 ? "failed" : "pending",
            attempts: (item.attempts ?? 0) + 1,
            error: err?.message ?? "unknown",
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
        failed++;
      }
    });

    await Promise.all(promises);

    // Report queue depth
    const { count: remaining } = await supabase
      .from("call_processing_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    return respond({ success: true, processed, failed, remaining: remaining ?? 0 });

  } catch (err: any) {
    console.error("[drain-call-queue] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
