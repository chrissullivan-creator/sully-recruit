import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CHICAGO_TIMEZONE = "America/Chicago";
const OUTBOUND_WINDOW_START_HOUR = 6;
const OUTBOUND_WINDOW_END_HOUR = 21;
const MIN_PACING_MINUTES = 3;
const MAX_PACING_MINUTES = 15;

/**
 * process-sequence-emails
 *
 * Called by pg_cron every minute. For each active enrollment due now:
 * - Enforces outbound pacing across the same account for paced channels (3-15 min random spacing)
 * - Uses America/Chicago for all send-window decisions (6:00 AM - 9:00 PM)
 * - Keeps recruiter/InMail channels exempt from paced outbound logic
 * - Creates execution records and queues sends
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

      // ── 4. Determine channel type for pacing/window behavior ───────
      const stepChannel = step.channel || step.step_type || sequence.channel || "";
      const isConnection = stepChannel === "linkedin_connection";
      const isInMail = stepChannel === "linkedin_recruiter" || stepChannel === "sales_nav";
      const isPacedChannel = !isInMail;

      // ── 5. Daily cap: 40/day for non-InMail channels ────────────────
      if (!isInMail) {
        const chicagoNowParts = getChicagoDateParts(now);
        const chicagoTodayStart = chicagoLocalToUtc(
          chicagoNowParts.year,
          chicagoNowParts.month,
          chicagoNowParts.day,
          0,
          0,
          0,
        );

        // For connections, count only connection executions; otherwise count all non-inmail
        const { data: todayExecs } = await supabase
          .from("sequence_step_executions")
          .select("id, sequence_step_id")
          .gte("executed_at", chicagoTodayStart.toISOString())
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
          const tomorrowAtWindowStart = moveToNextChicagoWindow(
            chicagoLocalToUtc(
              chicagoNowParts.year,
              chicagoNowParts.month,
              chicagoNowParts.day + 1,
              OUTBOUND_WINDOW_START_HOUR,
              0,
              0,
            )
          );

          await supabase
            .from("sequence_enrollments")
            .update({ next_step_at: tomorrowAtWindowStart.toISOString() } as any)
            .eq("id", enrollment.id);

          skipped++;
          continue;
        }
      }

      // ── 6. Calculate outbound schedule time ─────────────────────────
      let scheduledSendAt = new Date(now);

      if (isPacedChannel) {
        const accountId = step.account_id || enrollment.account_id;
        const nowDelayMinutes = randomInt(MIN_PACING_MINUTES, MAX_PACING_MINUTES);
        const fromNowCandidate = new Date(now.getTime() + nowDelayMinutes * 60 * 1000);

        let fromLatestOutboundCandidate = new Date(fromNowCandidate);
        if (accountId) {
          const { data: latestOutbound } = await supabase
            .from("sequence_step_executions")
            .select(`
              executed_at,
              sequence_enrollments!inner (
                account_id
              )
            `)
            .eq("sequence_enrollments.account_id", accountId)
            .in("status", ["scheduled", "sent"])
            .order("executed_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (latestOutbound?.executed_at) {
            const latestDelayMinutes = randomInt(MIN_PACING_MINUTES, MAX_PACING_MINUTES);
            const latestOutboundAt = new Date(latestOutbound.executed_at);
            fromLatestOutboundCandidate = new Date(
              latestOutboundAt.getTime() + latestDelayMinutes * 60 * 1000,
            );
          }
        }

        scheduledSendAt = new Date(
          Math.max(fromNowCandidate.getTime(), fromLatestOutboundCandidate.getTime()),
        );

        // Always enforce 6:00 AM - 9:00 PM America/Chicago send window for paced outbound
        scheduledSendAt = moveToNextChicagoWindow(scheduledSendAt);
      }

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
      let nextStepAt = new Date(scheduledSendAt.getTime() + nextDelayMs);

      if (isPacedChannel) {
        nextStepAt = moveToNextChicagoWindow(nextStepAt);
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

    // ── 9. Send scheduled executions ───────────────────────────────
    const { data: scheduledExecutions, error: sendError } = await supabase
      .from("sequence_step_executions")
      .select(`
        id,
        enrollment_id,
        sequence_step_id,
        executed_at,
        sequence_enrollments!inner (
          candidate_id,
          contact_id,
          prospect_id,
          enrolled_by,
          account_id,
          sequence_steps!inner (
            channel,
            subject,
            body,
            account_id
          )
        )
      `)
      .eq("status", "scheduled")
      .lte("executed_at", now.toISOString())
      .limit(50); // Limit to avoid overwhelming

    if (sendError) {
      console.error("Error fetching scheduled executions:", sendError);
    } else if (scheduledExecutions && scheduledExecutions.length > 0) {
      let sent = 0;
      let failed = 0;

      for (const exec of scheduledExecutions) {
        try {
          const enrollment = exec.sequence_enrollments as any;
          const step = enrollment.sequence_steps as any;

          // Determine recipient
          const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
          if (!entityId) {
            console.error("No entity ID for execution:", exec.id);
            failed++;
            continue;
          }

          // Get recipient address based on channel
          let to: string;
          let conversation_id: string;

          // Ensure conversation exists
          conversation_id = `seq_${exec.enrollment_id}`;
          const { data: existingConv } = await supabase
            .from("conversations")
            .select("id")
            .eq("id", conversation_id)
            .single();

          if (!existingConv) {
            await supabase
              .from("conversations")
              .insert({
                id: conversation_id,
                candidate_id: enrollment.candidate_id,
                contact_id: enrollment.contact_id,
                prospect_id: enrollment.prospect_id,
                owner_id: enrollment.enrolled_by,
                last_message_at: now.toISOString(),
              } as any);
          }

          if (step.channel === "email") {
            // For email, need to get email address
            const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
            const { data: entity } = await supabase
              .from(table)
              .select("email")
              .eq("id", entityId)
              .single();
            to = entity?.email;
          } else if (step.channel === "sms") {
            // For SMS, need phone number
            const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
            const { data: entity } = await supabase
              .from(table)
              .select("phone")
              .eq("id", entityId)
              .single();
            to = entity?.phone;
          } else if (step.channel.startsWith("linkedin")) {
            // For LinkedIn, use the provider_id from candidate_channels
            const { data: channel } = await supabase
              .from("candidate_channels")
              .select("provider_id, external_conversation_id")
              .eq("candidate_id", entityId)
              .eq("channel", "linkedin")
              .single();
            to = channel?.provider_id;
            if (channel?.external_conversation_id) {
              conversation_id = channel.external_conversation_id;
            }
          }

          if (!to) {
            console.error("No recipient address for execution:", exec.id);
            failed++;
            continue;
          }

          // Send the message using internal logic
          const result = await sendSequenceMessage(supabase, {
            channel: step.channel,
            conversation_id,
            candidate_id: enrollment.candidate_id,
            contact_id: enrollment.contact_id,
            to,
            subject: step.subject,
            body: step.body,
            account_id: step.account_id || enrollment.account_id,
            owner_id: enrollment.enrolled_by,
          });

          // Update execution
          await supabase
            .from("sequence_step_executions")
            .update({
              status: "sent",
              external_message_id: result.externalMessageId,
              external_conversation_id: result.externalConversationId,
              executed_at: now.toISOString(),
            } as any)
            .eq("id", exec.id);

          sent++;
        } catch (err: any) {
          console.error("Error sending execution:", exec.id, err);
          await supabase
            .from("sequence_step_executions")
            .update({
              status: "failed",
              error_message: err.message,
              executed_at: now.toISOString(),
            } as any)
            .eq("id", exec.id);
          failed++;
        }
      }

      console.log(`Sent ${sent} messages, ${failed} failed`);
    }

    const result = {
      processed,
      skipped,
      stopped,
      sent: scheduledExecutions?.length || 0,
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

// ─────────────────────────────────────────────────────────────────────────────
// SEND SEQUENCE MESSAGE (internal function)
// ─────────────────────────────────────────────────────────────────────────────
async function sendSequenceMessage(
  supabase: any,
  payload: {
    channel: string;
    conversation_id: string;
    candidate_id?: string;
    contact_id?: string;
    to: string;
    subject?: string;
    body: string;
    account_id?: string;
    owner_id: string;
  }
): Promise<{ externalMessageId: string | null; externalConversationId: string | null }> {
  const { channel, conversation_id, candidate_id, contact_id, to, subject, body, account_id, owner_id } = payload;

  let result: any;
  let externalMessageId: string | null = null;
  let externalConversationId: string | null = null;

  // Route to appropriate channel handler
  switch (channel) {
    case "email":
      result = await sendEmail(supabase, to, subject, body);
      externalMessageId = result.messageId;
      break;
    case "sms":
      result = await sendSms(supabase, to, body);
      externalMessageId = result.id?.toString();
      break;
    case "linkedin":
    case "linkedin_connection":
    case "linkedin_recruiter":
    case "sales_nav":
      result = await sendLinkedIn(supabase, to, body, account_id);
      externalMessageId = result.message_id;
      externalConversationId = result.conversation_id;
      break;
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }

  // Log the message in database
  const messageInsert: any = {
    conversation_id,
    candidate_id: candidate_id || null,
    contact_id: contact_id || null,
    channel,
    direction: "outbound",
    subject: subject || null,
    body,
    sender_address: result.sender || null,
    recipient_address: to,
    sent_at: new Date().toISOString(),
    external_message_id: externalMessageId,
    external_conversation_id: externalConversationId,
    provider: channel === "email" ? "smtp" : channel === "sms" ? "ringcentral" : "unipile",
    owner_id,
  };

  const { error: msgError } = await supabase.from("messages").insert(messageInsert);
  if (msgError) {
    console.error("Failed to log message:", msgError);
  }

  // Update conversation's last_message_at
  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: body.substring(0, 100),
      is_read: true,
    })
    .eq("id", conversation_id);

  return { externalMessageId, externalConversationId };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getChicagoDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function chicagoLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const localized = new Date(
    utcGuess.toLocaleString("en-US", {
      timeZone: CHICAGO_TIMEZONE,
    })
  );

  const offsetMs = localized.getTime() - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

function moveToNextChicagoWindow(input: Date): Date {
  const chicagoParts = getChicagoDateParts(input);

  if (
    chicagoParts.hour >= OUTBOUND_WINDOW_START_HOUR &&
    chicagoParts.hour < OUTBOUND_WINDOW_END_HOUR
  ) {
    return input;
  }

  if (chicagoParts.hour < OUTBOUND_WINDOW_START_HOUR) {
    return chicagoLocalToUtc(
      chicagoParts.year,
      chicagoParts.month,
      chicagoParts.day,
      OUTBOUND_WINDOW_START_HOUR,
      0,
      0,
    );
  }

  const nextChicagoDayStartUtc = chicagoLocalToUtc(
    chicagoParts.year,
    chicagoParts.month,
    chicagoParts.day + 1,
    OUTBOUND_WINDOW_START_HOUR,
    0,
    0,
  );

  return nextChicagoDayStartUtc;
}
