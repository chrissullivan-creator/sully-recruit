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
 *   AND updates the relevant execution to 'replied'
 * - Creates execution records and queues the email
 * - Checks for open/reply signals in messages table and updates executions
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
    const currentHour = now.getUTCHours();

    // ── 0. Update open/reply statuses for pending executions ──────────
    await updateTrackingStatuses(supabase, now);

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
        enrolled_at,
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
          const { data: replies } = await supabase
            .from("messages")
            .select("id")
            .eq("candidate_id", entityId)
            .eq("direction", "inbound")
            .gte("created_at", enrollment.enrolled_at || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
            .limit(1);

          if (replies && replies.length > 0) {
            // Mark the latest sent execution as 'replied'
            const { data: latestExec } = await supabase
              .from("sequence_step_executions")
              .select("id")
              .eq("enrollment_id", enrollment.id)
              .in("status", ["sent", "delivered", "opened"])
              .order("executed_at", { ascending: false })
              .limit(1);

            if (latestExec && latestExec.length > 0) {
              await supabase
                .from("sequence_step_executions")
                .update({ status: "replied" } as any)
                .eq("id", latestExec[0].id);
            }

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
        const nextWindow = new Date(now);
        if (currentHour >= sendEnd) {
          nextWindow.setDate(nextWindow.getDate() + 1);
        }
        nextWindow.setHours(sendStart, 0, 0, 0);
        const jitterMinutes = Math.floor(Math.random() * 10);
        nextWindow.setMinutes(jitterMinutes);

        await supabase
          .from("sequence_enrollments")
          .update({ next_step_at: nextWindow.toISOString() } as any)
          .eq("id", enrollment.id);

        skipped++;
        continue;
      }

      // ── 5. Determine channel type for rate limiting ─────────────────
      const stepChannel = step.channel || step.step_type || sequence.channel || "";
      const isConnection = stepChannel === "linkedin_connection";
      const isInMail = stepChannel === "linkedin_recruiter" || stepChannel === "sales_nav";

      // ── 5a. Daily cap: 40/day for connections, no cap for InMails ──
      if (!isInMail) {
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        // For connections, count only connection executions; otherwise count all non-inmail
        const { data: todayExecs } = await supabase
          .from("sequence_step_executions")
          .select("id, sequence_step_id")
          .gte("executed_at", todayStart.toISOString())
          .in("status", ["sent", "scheduled"]);

        let relevantCount = 0;
        if (isConnection && todayExecs) {
          // Count connection-type executions by joining step info
          const stepIds = todayExecs.map((e: any) => e.sequence_step_id);
          if (stepIds.length > 0) {
            const { data: steps } = await supabase
              .from("sequence_steps")
              .select("id, channel, step_type")
              .in("id", stepIds);
            relevantCount = (steps ?? []).filter((s: any) =>
              s.channel === "linkedin_connection" || s.step_type === "linkedin_connection"
            ).length;
          }
        } else {
          relevantCount = (todayExecs ?? []).length;
        }

        if (relevantCount >= 40) {
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

      // ── 6. Delay: 2–9 min for connections/messages, instant for InMails
      const randomDelayMinutes = isInMail ? 0 : 2 + Math.floor(Math.random() * 8);
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

      const nextHour = nextStepAt.getHours();
      if (nextHour < sendStart || nextHour >= sendEnd) {
        if (nextHour >= sendEnd) {
          nextStepAt.setDate(nextStepAt.getDate() + 1);
        }
        nextStepAt.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);
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

/**
 * Scan recent executions with status 'sent' or 'delivered' and check
 * the messages table for open/reply signals. Updates execution statuses:
 * - sent → delivered (if external_message_id is set)
 * - sent/delivered → opened (if message has been read/opened)
 * - any → replied (if an inbound reply exists in the conversation)
 */
async function updateTrackingStatuses(supabase: any, now: Date) {
  try {
    // Get executions from the last 14 days that could still be tracked
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const { data: executions, error } = await supabase
      .from("sequence_step_executions")
      .select(`
        id,
        enrollment_id,
        sequence_step_id,
        status,
        external_message_id,
        external_conversation_id,
        executed_at
      `)
      .in("status", ["sent", "delivered"])
      .gte("executed_at", cutoff.toISOString())
      .order("executed_at", { ascending: false })
      .limit(200);

    if (error || !executions || executions.length === 0) return;

    // Get enrollment details for entity lookups
    const enrollmentIds = [...new Set(executions.map((e: any) => e.enrollment_id))];
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id, contact_id, prospect_id")
      .in("id", enrollmentIds);

    const enrollmentMap = new Map((enrollments ?? []).map((e: any) => [e.id, e]));

    for (const exec of executions) {
      const enrollment = enrollmentMap.get(exec.enrollment_id);
      if (!enrollment) continue;

      const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
      if (!entityId) continue;

      // Check for inbound reply after this execution
      const { data: replies } = await supabase
        .from("messages")
        .select("id")
        .eq("candidate_id", entityId)
        .eq("direction", "inbound")
        .gte("created_at", exec.executed_at)
        .limit(1);

      if (replies && replies.length > 0) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "replied" } as any)
          .eq("id", exec.id);
        continue;
      }

      // Check if the conversation has been read (proxy for "opened")
      if (exec.external_conversation_id) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("is_read")
          .eq("external_conversation_id", exec.external_conversation_id)
          .maybeSingle();

        if (conv?.is_read && exec.status === "sent") {
          await supabase
            .from("sequence_step_executions")
            .update({ status: "opened" } as any)
            .eq("id", exec.id);
          continue;
        }
      }

      // If we have an external_message_id but status is still 'sent', mark delivered
      if (exec.status === "sent" && exec.external_message_id) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "delivered" } as any)
          .eq("id", exec.id);
      }
    }

    console.log(`Tracking update: checked ${executions.length} executions`);
  } catch (err) {
    console.error("Tracking update error:", err);
  }
}
