import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type AnyRecord = Record<string, any>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();
    const currentHour = now.getUTCHours();

    await updateTrackingStatuses(supabase, now);

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

    if (enrollError) throw enrollError;

    if (!enrollments?.length) {
      return json({ processed: 0, message: "No enrollments due" });
    }

    console.log("[sequence] enrollment pickup", { due: enrollments.length, at: now.toISOString() });

    let processed = 0;
    let skipped = 0;
    let stopped = 0;

    for (const enrollment of enrollments as AnyRecord[]) {
      console.log("[sequence] processing enrollment", {
        enrollment_id: enrollment.id,
        sequence_id: enrollment.sequence_id,
        current_step_order: enrollment.current_step_order,
        next_step_at: enrollment.next_step_at,
      });

      const sequence = enrollment.sequences as AnyRecord;
      const nextStepOrder = (enrollment.current_step_order ?? 0) + 1;

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

          if (replies?.length) {
            const { data: latestExec } = await supabase
              .from("sequence_step_executions")
              .select("id")
              .eq("enrollment_id", enrollment.id)
              .in("status", ["sent", "delivered", "opened"])
              .order("executed_at", { ascending: false })
              .limit(1);

            if (latestExec?.length) {
              await supabase.from("sequence_step_executions").update({ status: "replied" } as any).eq("id", latestExec[0].id);
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

      const recipient = await resolveRecipientAddress(supabase, enrollment, nextStepOrder);
      if (recipient.errorMessage) {
        await insertFailedExecution(supabase, {
          enrollmentId: enrollment.id,
          sequenceStepId: null,
          reason: recipient.errorMessage,
          context: { stage: "recipient_resolution", next_step_order: nextStepOrder },
        });
        await failEnrollment(supabase, enrollment.id, "invalid_enrollment_missing_recipient");
        continue;
      }

      const { data: step, error: stepError } = await supabase
        .from("sequence_steps")
        .select("*")
        .eq("sequence_id", enrollment.sequence_id)
        .eq("step_order", nextStepOrder)
        .eq("is_active", true)
        .maybeSingle();

      if (stepError) {
        await insertFailedExecution(supabase, {
          enrollmentId: enrollment.id,
          sequenceStepId: null,
          reason: `step lookup failed: ${stepError.message}`,
          context: { stage: "step_resolution", next_step_order: nextStepOrder },
        });
        continue;
      }

      console.log("[sequence] step resolution", {
        enrollment_id: enrollment.id,
        next_step_order: nextStepOrder,
        step_id: step?.id ?? null,
      });

      if (!step) {
        await insertFailedExecution(supabase, {
          enrollmentId: enrollment.id,
          sequenceStepId: null,
          reason: `no active step found for order ${nextStepOrder}`,
          context: { stage: "step_resolution" },
        });
        await failEnrollment(supabase, enrollment.id, "missing_or_inactive_step");
        continue;
      }

      const sendStart = step.send_window_start ?? 6;
      const sendEnd = step.send_window_end ?? 23;

      if (currentHour < sendStart || currentHour >= sendEnd) {
        const nextWindow = new Date(now);
        if (currentHour >= sendEnd) nextWindow.setDate(nextWindow.getDate() + 1);
        nextWindow.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);

        await supabase.from("sequence_enrollments").update({ next_step_at: nextWindow.toISOString() } as any).eq("id", enrollment.id);
        skipped++;
        continue;
      }

      const stepChannel = step.channel || step.step_type || sequence.channel || "";
      const isConnection = stepChannel === "linkedin_connection";
      const isInMail = stepChannel === "linkedin_recruiter" || stepChannel === "sales_nav";

      if (!isInMail) {
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const { data: todayExecs } = await supabase
          .from("sequence_step_executions")
          .select("id, sequence_step_id")
          .gte("executed_at", todayStart.toISOString())
          .in("status", ["sent", "scheduled"]);

        let relevantCount = 0;
        if (isConnection && todayExecs?.length) {
          const stepIds = todayExecs.map((e: AnyRecord) => e.sequence_step_id).filter(Boolean);
          if (stepIds.length) {
            const { data: steps } = await supabase
              .from("sequence_steps")
              .select("id, channel, step_type")
              .in("id", stepIds);
            relevantCount = (steps ?? []).filter((s: AnyRecord) => s.channel === "linkedin_connection" || s.step_type === "linkedin_connection").length;
          }
        } else {
          relevantCount = (todayExecs ?? []).length;
        }

        if (relevantCount >= 40) {
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(sendStart, Math.floor(Math.random() * 10), 0, 0);
          await supabase.from("sequence_enrollments").update({ next_step_at: tomorrow.toISOString() } as any).eq("id", enrollment.id);
          skipped++;
          continue;
        }
      }

      const randomDelayMinutes = isInMail ? 0 : 2 + Math.floor(Math.random() * 8);
      const scheduledSendAt = new Date(now.getTime() + randomDelayMinutes * 60 * 1000);

      const { data: insertedExecution, error: execError } = await supabase
        .from("sequence_step_executions")
        .insert({
          enrollment_id: enrollment.id,
          sequence_step_id: step.id,
          status: "scheduled",
          executed_at: scheduledSendAt.toISOString(),
        } as any)
        .select("id")
        .single();

      if (execError || !insertedExecution) {
        await insertFailedExecution(supabase, {
          enrollmentId: enrollment.id,
          sequenceStepId: step.id,
          reason: `execution insert failed: ${execError?.message ?? "unknown"}`,
          context: { stage: "execution_insert", step_id: step.id },
        });
        continue;
      }

      console.log("[sequence] execution insert", {
        enrollment_id: enrollment.id,
        execution_id: insertedExecution.id,
        step_id: step.id,
        scheduled_for: scheduledSendAt.toISOString(),
      });

      const nextDelayMs = (((step.delay_days ?? 0) * 24 * 60) + ((step.delay_hours ?? 0) * 60)) * 60 * 1000;
      const nextStepAt = new Date(scheduledSendAt.getTime() + nextDelayMs);
      const nextHour = nextStepAt.getHours();
      if (nextHour < sendStart || nextHour >= sendEnd) {
        if (nextHour >= sendEnd) nextStepAt.setDate(nextStepAt.getDate() + 1);
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
        enrollment_id: enrollment.id,
        new_current_step_order: nextStepOrder,
        next_step_at: nextStepAt.toISOString(),
      });

      processed++;
    }

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
      .limit(50);

    if (sendError) {
      console.error("Error fetching scheduled executions:", sendError);
    }

    let sent = 0;
    let failed = 0;

    for (const exec of (scheduledExecutions ?? []) as AnyRecord[]) {
      const enrollment = exec.sequence_enrollments as AnyRecord;
      const step = enrollment.sequence_steps as AnyRecord;

      try {
        const recipient = await resolveRecipientForExecution(supabase, enrollment, step.channel);
        if (recipient.errorMessage || !recipient.to) {
          throw new Error(recipient.errorMessage || "recipient resolution failed");
        }

        const account = await resolveAccountForStep(supabase, {
          channel: step.channel,
          ownerId: enrollment.enrolled_by,
          explicitAccountId: step.account_id || enrollment.account_id,
        });

        console.log("[sequence] account resolution", {
          execution_id: exec.id,
          channel: step.channel,
          account_id: account.accountId ?? null,
          provider: account.provider,
        });

        console.log("[sequence] send attempt", {
          execution_id: exec.id,
          channel: step.channel,
          has_subject: Boolean(step.subject),
        });

        const result = await sendSequenceMessage(supabase, {
          channel: step.channel,
          conversation_id: recipient.conversationId,
          candidate_id: enrollment.candidate_id,
          contact_id: enrollment.contact_id,
          to: recipient.to,
          subject: step.subject,
          body: step.body,
          owner_id: enrollment.enrolled_by,
          account,
        });

        await supabase
          .from("sequence_step_executions")
          .update({
            status: "sent",
            external_message_id: result.externalMessageId,
            external_conversation_id: result.externalConversationId,
            executed_at: now.toISOString(),
            error_message: null,
          } as any)
          .eq("id", exec.id);

        sent++;
      } catch (err: any) {
        await supabase
          .from("sequence_step_executions")
          .update({ status: "failed", error_message: err.message, executed_at: now.toISOString() } as any)
          .eq("id", exec.id);

        await failEnrollment(supabase, exec.enrollment_id, "send_failure");
        failed++;
      }
    }

    return json({
      processed,
      skipped,
      stopped,
      sent,
      failed,
      total: enrollments.length,
      timestamp: now.toISOString(),
    });
  } catch (err: any) {
    console.error("Process error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function json(data: AnyRecord) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveRecipientAddress(supabase: any, enrollment: AnyRecord, nextStepOrder: number) {
  const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
  if (!entityId) {
    return { errorMessage: "missing contact_id/candidate_id/prospect_id" };
  }

  const { data: step } = await supabase
    .from("sequence_steps")
    .select("channel")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_order", nextStepOrder)
    .eq("is_active", true)
    .maybeSingle();

  if (!step) {
    return { errorMessage: `missing or inactive step ${nextStepOrder}` };
  }

  const recipient = await resolveRecipientForExecution(supabase, enrollment, step.channel);
  if (recipient.errorMessage || !recipient.to) {
    return { errorMessage: recipient.errorMessage || "missing recipient address" };
  }

  return { errorMessage: null };
}

async function resolveRecipientForExecution(supabase: any, enrollment: AnyRecord, channel: string) {
  const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
  if (!entityId) {
    return { errorMessage: "missing recipient entity id", to: null, conversationId: null };
  }

  let to: string | null = null;
  let conversationId = `seq_${enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id}_${enrollment.enrolled_by || "system"}`;

  const { data: existingConv } = await supabase.from("conversations").select("id").eq("id", conversationId).maybeSingle();
  if (!existingConv) {
    await supabase.from("conversations").insert({
      id: conversationId,
      candidate_id: enrollment.candidate_id,
      contact_id: enrollment.contact_id,
      prospect_id: enrollment.prospect_id,
      owner_id: enrollment.enrolled_by,
      channel: channel || "email",
      last_message_at: new Date().toISOString(),
    } as any);
  }

  if (channel === "email") {
    const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
    const { data: entity } = await supabase.from(table).select("email").eq("id", entityId).maybeSingle();
    to = entity?.email ?? null;
  } else if (channel === "sms") {
    const table = enrollment.candidate_id ? "candidates" : enrollment.contact_id ? "contacts" : "prospects";
    const { data: entity } = await supabase.from(table).select("phone").eq("id", entityId).maybeSingle();
    to = entity?.phone ?? null;
  } else if (String(channel).startsWith("linkedin")) {
    const { data: row } = await supabase
      .from("candidate_channels")
      .select("provider_id, external_conversation_id")
      .eq("candidate_id", entityId)
      .eq("channel", "linkedin")
      .maybeSingle();

    to = row?.provider_id ?? null;
    if (row?.external_conversation_id) conversationId = row.external_conversation_id;
  }

  if (!to) return { errorMessage: `missing recipient address for channel ${channel}`, to: null, conversationId };

  return { errorMessage: null, to, conversationId };
}

async function resolveAccountForStep(
  supabase: any,
  payload: { channel: string; ownerId: string; explicitAccountId?: string },
) {
  const { channel, ownerId, explicitAccountId } = payload;

  if (channel !== "email") {
    return { provider: "non_email", accountId: explicitAccountId ?? null, config: null };
  }

  if (explicitAccountId) {
    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, provider, is_active, provider_config")
      .eq("id", explicitAccountId)
      .maybeSingle();

    if (!account || !account.is_active || String(account.provider).toLowerCase() !== "microsoft") {
      throw new Error("no valid Microsoft account exists for this step");
    }

    return { provider: "microsoft", accountId: account.id, config: account.provider_config };
  }

  const { data: outlook } = await supabase
    .from("user_integrations")
    .select("id, config")
    .eq("user_id", ownerId)
    .eq("integration_type", "outlook")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!outlook) throw new Error("no valid Microsoft account exists for owner");

  return { provider: "microsoft", accountId: outlook.id, config: outlook.config };
}

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
    owner_id: string;
    account: { provider: string; accountId: string | null; config: any };
  },
): Promise<{ externalMessageId: string | null; externalConversationId: string | null }> {
  const { channel, conversation_id, candidate_id, contact_id, to, subject, body, owner_id, account } = payload;

  let result: AnyRecord;
  let externalMessageId: string | null = null;
  let externalConversationId: string | null = null;

  switch (channel) {
    case "email":
      result = await sendEmailMicrosoftOnly(to, subject, body, account.config);
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
      result = await sendLinkedIn(supabase, to, body, account.accountId ?? undefined);
      externalMessageId = result.message_id;
      externalConversationId = result.conversation_id;
      break;
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }

  await supabase.from("messages").insert({
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
    provider: channel === "email" ? "microsoft" : channel === "sms" ? "ringcentral" : "unipile",
    owner_id,
  } as any);

  await supabase.from("conversations").update({
    last_message_at: new Date().toISOString(),
    last_message_preview: body.substring(0, 100),
    is_read: true,
  }).eq("id", conversation_id);

  return { externalMessageId, externalConversationId };
}

async function sendEmailMicrosoftOnly(
  to: string,
  subject: string | undefined,
  body: string,
  outlookConfig: AnyRecord,
): Promise<{ messageId: string; sender: string }> {
  const accessToken = outlookConfig?.access_token;
  const fromEmail = outlookConfig?.email;

  if (!accessToken) throw new Error("expired Microsoft token or missing access token");

  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: subject || "",
        body: { contentType: "HTML", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`send failure from Graph: ${errorText}`);
  }

  return { messageId: crypto.randomUUID(), sender: fromEmail || "microsoft" };
}

async function sendSms(supabase: any, to: string, body: string): Promise<{ id: string; sender: string }> {
  const ringcentralConfig = await getRingCentralConfig();
  if (!ringcentralConfig) throw new Error("RingCentral not configured");

  const authResponse = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${ringcentralConfig.client_id}:${ringcentralConfig.client_secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: ringcentralConfig.phone_number,
      password: ringcentralConfig.jwt_token,
      extension: "",
    }),
  });

  if (!authResponse.ok) throw new Error("RingCentral auth failed");

  const authData = await authResponse.json();
  const smsResponse = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authData.access_token}`,
      "Content-Type": "application/json",
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

async function sendLinkedIn(supabase: any, to: string, body: string, account_id?: string) {
  if (!account_id) throw new Error("LinkedIn account_id required");

  const { data: account } = await supabase
    .from("integration_accounts")
    .select("provider_config")
    .eq("id", account_id)
    .single();

  if (!account?.provider_config?.unipile_api_key) throw new Error("Unipile API key not found");

  const response = await fetch("https://api.unipile.com:13111/api/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.provider_config.unipile_api_key}`,
      "Content-Type": "application/json",
      "X-UNIPILE-CLIENT": "sully-recruit",
    },
    body: JSON.stringify({ provider_id: to, text: body }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Unipile error: ${error}`);
  }

  const data = await response.json();
  return { message_id: data.id, conversation_id: data.conversation_id };
}

async function getRingCentralConfig() {
  const clientId = Deno.env.get("RINGCENTRAL_CLIENT_ID");
  if (!clientId) return null;

  return {
    client_id: clientId,
    client_secret: Deno.env.get("RINGCENTRAL_CLIENT_SECRET"),
    jwt_token: Deno.env.get("RINGCENTRAL_JWT_TOKEN"),
    phone_number: Deno.env.get("RINGCENTRAL_PHONE_NUMBER"),
  };
}

async function insertFailedExecution(
  supabase: any,
  payload: { enrollmentId: string; sequenceStepId: string | null; reason: string; context?: AnyRecord },
) {
  console.error("[sequence] execution failure", payload);
  await supabase.from("sequence_step_executions").insert({
    enrollment_id: payload.enrollmentId,
    sequence_step_id: payload.sequenceStepId,
    status: "failed",
    executed_at: new Date().toISOString(),
    error_message: payload.reason,
    raw_payload: payload.context ?? {},
  } as any);
}

async function failEnrollment(supabase: any, enrollmentId: string, reason: string) {
  await supabase.from("sequence_enrollments").update({
    status: "failed",
    stopped_reason: reason,
    completed_at: new Date().toISOString(),
  } as any).eq("id", enrollmentId).eq("status", "active");
}

async function updateTrackingStatuses(supabase: any, now: Date) {
  try {
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const { data: executions } = await supabase
      .from("sequence_step_executions")
      .select("id,enrollment_id,status,external_message_id,external_conversation_id,executed_at")
      .in("status", ["sent", "delivered"])
      .gte("executed_at", cutoff.toISOString())
      .order("executed_at", { ascending: false })
      .limit(200);

    if (!executions?.length) return;

    const enrollmentIds = [...new Set(executions.map((e: AnyRecord) => e.enrollment_id))];
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("id, candidate_id, contact_id, prospect_id")
      .in("id", enrollmentIds);

    const enrollmentMap = new Map((enrollments ?? []).map((e: AnyRecord) => [e.id, e]));

    for (const exec of executions as AnyRecord[]) {
      const enrollment = enrollmentMap.get(exec.enrollment_id);
      if (!enrollment) continue;

      const entityId = enrollment.candidate_id || enrollment.contact_id || enrollment.prospect_id;
      if (!entityId) continue;

      const { data: replies } = await supabase
        .from("messages")
        .select("id")
        .eq("candidate_id", entityId)
        .eq("direction", "inbound")
        .gte("created_at", exec.executed_at)
        .limit(1);

      if (replies?.length) {
        await supabase.from("sequence_step_executions").update({ status: "replied" } as any).eq("id", exec.id);
        continue;
      }

      if (exec.external_conversation_id) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("is_read")
          .eq("external_conversation_id", exec.external_conversation_id)
          .maybeSingle();

        if (conv?.is_read && exec.status === "sent") {
          await supabase.from("sequence_step_executions").update({ status: "opened" } as any).eq("id", exec.id);
          continue;
        }
      }

      if (exec.status === "sent" && exec.external_message_id) {
        await supabase.from("sequence_step_executions").update({ status: "delivered" } as any).eq("id", exec.id);
      }
    }
  } catch (err) {
    console.error("Tracking update error:", err);
  }
}
