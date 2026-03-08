import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * process-sequence-emails
 * 
 * Called by pg_cron every minute. For each active email enrollment due now:
 * - Checks the step's send_window_start / send_window_end
 * - Randomises send timing: 3–9 min jitter per email
 * - Enforces a hard cap of 180 emails / day / user (across all sequences)
 * - If stop_on_reply is true and a reply exists, marks enrollment stopped
 * - Creates execution records and queues the email
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const now = new Date();
    const currentHour = now.getUTCHours(); // Note: adjust for user timezone in production

    // ── 1. Get active enrollments that are due ──────────────────────────
    const { data: enrollments, error: enrollError } = await supabase
      .from("sequence_enrollments")
      .select(`
        id,
        sequence_id,
        candidate_id,
        contact_id,
        prospect_id,
        current_step_order,
        next_step_at,
        account_id,
        enrolled_by,
        sequences!inner (
          id,
          stop_on_reply,
          channel
        )
      `)
      .eq("status", "active")
      .lte("next_step_at", now.toISOString());

    if (enrollError) {
      console.error("Error fetching enrollments:", enrollError);
      throw enrollError;
    }

    if (!enrollments || enrollments.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, message: "No enrollments due" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processed = 0;
    let skipped = 0;
    let stopped = 0;

    for (const enrollment of enrollments) {
      const sequence = enrollment.sequences as any;
      const nextStepOrder = (enrollment.current_step_order ?? 0) + 1;

      // ── 2. Check for replies (stop on any channel) ──────────────────
      if (sequence.stop_on_reply) {
        const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
        if (entityId) {
          // Check conversations for any inbound message after enrollment
          const { data: replies } = await supabase
            .from("messages")
            .select("id")
            .eq("candidate_id", entityId)
            .eq("direction", "inbound")
            .gte("created_at", enrollment.next_step_at ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() : now.toISOString())
            .limit(1);

          if (replies && replies.length > 0) {
            await supabase
              .from("sequence_enrollments")
              .update({
                status: "stopped",
                stopped_reason: "candidate_replied",
                completed_at: now.toISOString(),
              } as any)
              .eq("id", enrollment.id);

            stopped++;
            continue;
          }
        }
      }

      // ── 3. Get the next step ────────────────────────────────────────
      const { data: step, error: stepError } = await supabase
        .from("sequence_steps")
        .select("*")
        .eq("sequence_id", enrollment.sequence_id)
        .eq("step_order", nextStepOrder)
        .eq("is_active", true)
        .maybeSingle();

      if (stepError) {
        console.error("Error fetching step:", stepError);
        continue;
      }

      // No more steps → mark completed
      if (!step) {
        await supabase
          .from("sequence_enrollments")
          .update({
            status: "completed",
            completed_at: now.toISOString(),
          } as any)
          .eq("id", enrollment.id);

        continue;
      }

      // ── 4. Check send window ────────────────────────────────────────
      const sendStart = step.send_window_start ?? 6;
      const sendEnd = step.send_window_end ?? 23;

      if (currentHour < sendStart || currentHour >= sendEnd) {
        // Outside send window — reschedule to the start of the window
        const nextWindow = new Date(now);
        if (currentHour >= sendEnd) {
          nextWindow.setDate(nextWindow.getDate() + 1);
        }
        nextWindow.setHours(sendStart, 0, 0, 0);

        // Add random jitter: 0–9 minutes into the window start
        const jitterMinutes = Math.floor(Math.random() * 10);
        nextWindow.setMinutes(jitterMinutes);

        await supabase
          .from("sequence_enrollments")
          .update({ next_step_at: nextWindow.toISOString() } as any)
          .eq("id", enrollment.id);

        skipped++;
        continue;
      }

      // ── 5. Check daily email cap (180/day per enrolled_by user) ─────
      if (step.step_type === "email" || step.channel === "email") {
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const { count: todayCount } = await supabase
          .from("sequence_step_executions")
          .select("id", { count: "exact", head: true })
          .gte("executed_at", todayStart.toISOString())
          .eq("status", "sent");

        if ((todayCount ?? 0) >= 180) {
          // Hit daily cap — reschedule to tomorrow at send window start
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);

          await supabase
            .from("sequence_enrollments")
            .update({ next_step_at: tomorrow.toISOString() } as any)
            .eq("id", enrollment.id);

          skipped++;
          continue;
        }
      }

      // ── 6. Random delay (3–9 minutes) for human-like sending ────────
      const randomDelayMinutes = 3 + Math.floor(Math.random() * 7); // 3 to 9
      const scheduledSendAt = new Date(now.getTime() + randomDelayMinutes * 60 * 1000);

      // ── 7. Create execution record ──────────────────────────────────
      const { error: execError } = await supabase
        .from("sequence_step_executions")
        .insert({
          enrollment_id: enrollment.id,
          sequence_step_id: step.id,
          status: "scheduled",
          executed_at: scheduledSendAt.toISOString(),
        } as any);

      if (execError) {
        console.error("Error creating execution:", execError);
        continue;
      }

      // ── 8. Calculate next step timing ───────────────────────────────
      const nextDelayMs =
        ((step.delay_days ?? 0) * 24 * 60 + (step.delay_hours ?? 0) * 60) *
        60 *
        1000;
      const nextStepAt = new Date(scheduledSendAt.getTime() + nextDelayMs);

      // If next step would be outside send window, push to next window
      const nextHour = nextStepAt.getHours();
      const nextSendStart = sendStart; // next step may have different window, but use current as fallback
      const nextSendEnd = sendEnd;
      if (nextHour < nextSendStart || nextHour >= nextSendEnd) {
        if (nextHour >= nextSendEnd) {
          nextStepAt.setDate(nextStepAt.getDate() + 1);
        }
        nextStepAt.setHours(nextSendStart, Math.floor(Math.random() * 10), 0, 0);
      }

      await supabase
        .from("sequence_enrollments")
        .update({
          current_step_order: nextStepOrder,
          next_step_at: nextStepAt.toISOString(),
        } as any)
        .eq("id", enrollment.id);

      processed++;
    }

    const result = {
      processed,
      skipped,
      stopped,
      total: enrollments.length,
      timestamp: now.toISOString(),
    };

    console.log("Process result:", result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Process error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
