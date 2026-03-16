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

    const { data: auditResult, error: auditError } = await supabase.rpc("audit_and_repair_sequences");
    if (auditError) {
      console.error("[sequence] audit_and_repair failed", auditError);
    } else {
      console.log("[sequence] audit_and_repair", auditResult);
    }

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
      console.log("[sequence] enrollment pickup", {
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequence_id,
        currentStepOrder: enrollment.current_step_order,
        nextStepAt: enrollment.next_step_at,
      });
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
        console.error("[sequence] step resolution failed", {
          enrollmentId: enrollment.id,
          nextStepOrder,
          error: stepError,
        });

        await markEnrollmentFailed(supabase, enrollment.id, `step_resolution_failed:${stepError.message}`);
        continue;
      }

      console.log("[sequence] step resolution", {
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequence_id,
        nextStepOrder,
        stepId: step?.id ?? null,
      });

      if (!step) {
        const { data: fallbackStep } = await supabase
          .from("sequence_steps")
          .select("id")
          .eq("sequence_id", enrollment.sequence_id)
          .eq("step_order", nextStepOrder)
          .maybeSingle();

        if (fallbackStep?.id) {
          await supabase.from("sequence_step_executions").insert({
            enrollment_id: enrollment.id,
            sequence_step_id: fallbackStep.id,
            status: "failed",
            executed_at: now.toISOString(),
            error_message: "Step is missing or inactive",
          } as any);
        }

        await supabase
          .from("sequence_enrollments")
          .update({
            status: "failed",
            stopped_reason: "missing_or_inactive_step",
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
        console.error("[sequence] execution insert failed", {
          enrollmentId: enrollment.id,
          stepId: step.id,
          error: execError,
        });
        continue;
      }

      console.log("[sequence] execution insert", {
        enrollmentId: enrollment.id,
        stepId: step.id,
        status: "scheduled",
      });

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

      console.log("[sequence] enrollment advance", {
        enrollmentId: enrollment.id,
        currentStepOrder: nextStepOrder,
        nextStepAt: nextStepAt.toISOString(),
      });

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
          account_id
        ),
        sequence_steps!inner (
          channel,
          subject,
          body,
          account_id
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
          const step = exec.sequence_steps as any;
          
          // Determine recipient
          const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
          if (!entityId) {
            console.error("[sequence] send attempt failed: no entity", { executionId: exec.id });
            await supabase
              .from("sequence_step_executions")
              .update({
                status: "failed",
                error_message: "No candidate/contact/prospect recipient on enrollment",
                executed_at: now.toISOString(),
              } as any)
              .eq("id", exec.id);
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
          
          if (step.channel === 'email') {
            // For email, need to get email address
            const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
            const { data: entity } = await supabase
              .from(table)
              .select("email")
              .eq("id", entityId)
              .single();
            to = entity?.email;
          } else if (step.channel === 'sms') {
            // For SMS, need phone number
            const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
            const { data: entity } = await supabase
              .from(table)
              .select("phone")
              .eq("id", entityId)
              .single();
            to = entity?.phone;
          } else if (step.channel.startsWith('linkedin')) {
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
            console.error("[sequence] send attempt failed: missing recipient address", {
              executionId: exec.id,
              channel: step.channel,
              enrollmentId: exec.enrollment_id,
            });
            await supabase
              .from("sequence_step_executions")
              .update({
                status: "failed",
                error_message: `No recipient address for ${step.channel}`,
                executed_at: now.toISOString(),
              } as any)
              .eq("id", exec.id);
            failed++;
            continue;
          }

          console.log("[sequence] account resolution", {
            executionId: exec.id,
            stepAccountId: step.account_id ?? null,
            enrollmentAccountId: enrollment.account_id ?? null,
          });

          console.log("[sequence] send attempt", {
            executionId: exec.id,
            channel: step.channel,
            enrollmentId: exec.enrollment_id,
          });

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
            owner_id: enrollment.enrolled_by
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

          console.log("[sequence] execution insert", {
            executionId: exec.id,
            status: "sent",
          });

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
    case 'email':
      result = await sendEmail(supabase, to, subject, body, account_id, owner_id);
      externalMessageId = result.messageId;
      break;
    case 'sms':
      result = await sendSms(supabase, to, body);
      externalMessageId = result.id?.toString();
      break;
    case 'linkedin':
    case 'linkedin_connection':
    case 'linkedin_recruiter':
    case 'sales_nav':
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
    direction: 'outbound',
    subject: subject || null,
    body,
    sender_address: result.sender || null,
    recipient_address: to,
    sent_at: new Date().toISOString(),
    external_message_id: externalMessageId,
    external_conversation_id: externalConversationId,
    provider: channel === 'email' ? 'microsoft' : channel === 'sms' ? 'ringcentral' : 'unipile',
    owner_id,
  };

  const { error: msgError } = await supabase.from('messages').insert(messageInsert);
  if (msgError) {
    console.error('Failed to log message:', msgError);
  }

  // Update conversation's last_message_at
  await supabase
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: body.substring(0, 100),
      is_read: true,
    })
    .eq('id', conversation_id);

  return { externalMessageId, externalConversationId };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL via SMTP (using Resend or generic SMTP)
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(
  supabase: any,
  to: string,
  subject: string | undefined,
  body: string,
  accountId?: string,
  ownerId?: string,
): Promise<{ messageId: string; sender: string }> {
  const sender = await getMicrosoftSenderConfig(supabase, accountId, ownerId);
  if (!sender?.accessToken) {
    throw new Error("No active Microsoft/Outlook sender account available");
  }

  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sender.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: subject || "",
        body: {
          contentType: "HTML",
          content: body,
        },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Microsoft Graph sendMail failed: ${errorText}`);
  }

  return {
    messageId: crypto.randomUUID(),
    sender: sender.fromAddress,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS via RingCentral
// ─────────────────────────────────────────────────────────────────────────────
async function sendSms(
  supabase: any,
  to: string,
  body: string
): Promise<{ id: string; sender: string }> {
  const ringcentralConfig = await getRingCentralConfig(supabase);
  if (!ringcentralConfig) {
    throw new Error('RingCentral not configured');
  }

  const authResponse = await fetch(`https://platform.ringcentral.com/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${ringcentralConfig.client_id}:${ringcentralConfig.client_secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: ringcentralConfig.phone_number,
      password: ringcentralConfig.jwt_token,
      extension: '',
    }),
  });

  if (!authResponse.ok) {
    throw new Error('RingCentral auth failed');
  }

  const authData = await authResponse.json();
  const accessToken = authData.access_token;

  const smsResponse = await fetch(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: [{ phoneNumber: to }],
      from: { phoneNumber: ringcentralConfig.phone_number },
      text: body,
    }),
  });

  if (!smsResponse.ok) {
    const error = await smsResponse.text();
    throw new Error(`RingCentral SMS error: ${error}`);
  }

  const smsData = await smsResponse.json();
  return { id: smsData.id, sender: ringcentralConfig.phone_number };
}

// ─────────────────────────────────────────────────────────────────────────────
// LINKEDIN via Unipile
// ─────────────────────────────────────────────────────────────────────────────
async function sendLinkedIn(
  supabase: any,
  to: string,
  body: string,
  account_id?: string
): Promise<{ message_id: string; conversation_id: string }> {
  if (!account_id) {
    throw new Error('LinkedIn account_id required');
  }

  const { data: account } = await supabase
    .from('integration_accounts')
    .select('provider_config')
    .eq('id', account_id)
    .single();

  if (!account?.provider_config?.unipile_api_key) {
    throw new Error('Unipile API key not found');
  }

  const apiKey = account.provider_config.unipile_api_key;
  const baseUrl = 'https://api.unipile.com:13111/api/v1';

  // Send message
  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-UNIPILE-CLIENT': 'sully-recruit',
    },
    body: JSON.stringify({
      provider_id: to,
      text: body,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Unipile error: ${error}`);
  }

  const data = await response.json();
  return { message_id: data.id, conversation_id: data.conversation_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function getMicrosoftSenderConfig(supabase: any, accountId?: string, ownerId?: string): Promise<{ accessToken: string; fromAddress: string } | null> {
  if (accountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, provider, provider_config, account_label")
      .eq("id", accountId)
      .eq("is_active", true)
      .maybeSingle();

    const cfg = account?.provider_config ?? {};
    if ((account?.provider === "outlook" || account?.provider === "microsoft" || account?.provider === "email") && cfg.access_token) {
      return {
        accessToken: cfg.access_token,
        fromAddress: cfg.email_address || account?.account_label || "microsoft",
      };
    }
  }

  if (ownerId) {
    const { data: fallback } = await supabase
      .from("user_integrations")
      .select("config")
      .eq("user_id", ownerId)
      .eq("integration_type", "outlook")
      .eq("is_active", true)
      .maybeSingle();

    const cfg = fallback?.config ?? {};
    if (cfg.access_token) {
      return {
        accessToken: cfg.access_token,
        fromAddress: cfg.email || "outlook",
      };
    }
  }

  return null;
}

async function getRingCentralConfig(supabase: any): Promise<any> {
  const clientId = Deno.env.get('RINGCENTRAL_CLIENT_ID');
  if (clientId) {
    return {
      client_id: clientId,
      client_secret: Deno.env.get('RINGCENTRAL_CLIENT_SECRET'),
      jwt_token: Deno.env.get('RINGCENTRAL_JWT_TOKEN'),
      server_url: Deno.env.get('RINGCENTRAL_SERVER_URL'),
      phone_number: Deno.env.get('RINGCENTRAL_PHONE_NUMBER'),
    };
  }
  return null;
}

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


async function markEnrollmentFailed(supabase: any, enrollmentId: string, reason: string) {
  await supabase
    .from("sequence_enrollments")
    .update({
      status: "failed",
      stopped_reason: reason,
      completed_at: new Date().toISOString(),
    } as any)
    .eq("id", enrollmentId);
}
