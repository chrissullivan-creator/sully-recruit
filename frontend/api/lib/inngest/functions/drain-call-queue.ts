import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";

/**
 * Drain the `call_processing_queue` — picks up `pending` calls and POSTs
 * them to the `process-call-recording` Supabase edge function for
 * Deepgram transcription + AI analysis.
 *
 * 5/run, attempts capped at 3, marks `failed` on the third miss so a
 * single broken recording can't block the queue.
 *
 * Every 3 minutes. Ported from `src/trigger/drain-call-queue.ts` —
 * Inngest is the only scheduler now.
 */
export const drainCallQueue = inngest.createFunction(
  { id: "drain-call-queue", name: "Drain call processing queue (Inngest)" },
  { cron: "*/3 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const batchSize = 5;

    const { data: batch, error } = await supabase
      .from("call_processing_queue")
      .select("*")
      .eq("status", "pending")
      .lt("attempts", 3)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (error) {
      throw new Error(`Queue read error: ${error.message}`);
    }

    if (!batch?.length) {
      logger.info("Queue empty");
      return { processed: 0, failed: 0, remaining: 0 };
    }

    const ids = batch.map((r: any) => r.id);
    await supabase
      .from("call_processing_queue")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .in("id", ids);

    let processed = 0,
      failed = 0;
    const supabaseUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const promises = batch.map(async (item: any) => {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/process-call-recording`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
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
          signal: AbortSignal.timeout(90_000),
        });

        const result = await res.json();

        if (result.skipped || result.success) {
          await supabase
            .from("call_processing_queue")
            .update({ status: "done", updated_at: new Date().toISOString() })
            .eq("id", item.id);
          processed++;
        } else {
          throw new Error(result.error ?? "Unknown error");
        }
      } catch (err: any) {
        logger.error(`Failed processing call ${item.call_id}`, { error: err.message });
        await supabase
          .from("call_processing_queue")
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

    const { count: remaining } = await supabase
      .from("call_processing_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    logger.info("Queue drain complete", { processed, failed, remaining: remaining ?? 0 });
    return { processed, failed, remaining: remaining ?? 0 };
  },
);
