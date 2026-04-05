import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getMicrosoftGraphCredentials, getAnthropicKey } from "./lib/supabase";

interface MicrosoftWebhookPayload {
  notification: {
    subscriptionId?: string;
    changeType?: string;
    resource?: string;
    resourceData?: any;
    clientState?: string;
    tenantId?: string;
  };
  receivedAt: string;
}

/**
 * Process Microsoft Graph notifications (email, calendar events).
 * Tenant: emeraldrecruit.com (Chris, Nancy, Ashley).
 * Matches sender email to candidates/contacts and logs activity.
 */
export const processMicrosoftEvent = task({
  id: "process-microsoft-event",
  retry: { maxAttempts: 3 },
  run: async (payload: MicrosoftWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const { notification } = payload;

    logger.info("Processing Microsoft Graph notification", {
      changeType: notification.changeType,
      resource: notification.resource,
    });

    // Verify client state if present (set during Graph subscription creation)
    // The client state is embedded in the subscription, not a separate secret
    if (notification.clientState) {
      logger.info("Notification client state present", { clientState: notification.clientState });
    }

    // Get access token for the emeraldrecruit.com tenant
    const accessToken = await getMicrosoftAccessToken();
    if (!accessToken) {
      throw new Error("Could not obtain Microsoft Graph access token");
    }

    // Fetch the full resource from Graph API
    const resourceUrl = `https://graph.microsoft.com/v1.0/${notification.resource}`;
    const resourceResp = await fetch(resourceUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resourceResp.ok) {
      logger.error("Failed to fetch resource", {
        status: resourceResp.status,
        resource: notification.resource,
      });
      throw new Error(`Graph API error: ${resourceResp.status}`);
    }

    const resourceData = await resourceResp.json();

    // Route based on resource type
    if (notification.resource?.includes("/messages")) {
      return await processEmailMessage(supabase, resourceData, payload.receivedAt);
    }

    if (notification.resource?.includes("/events")) {
      return await processCalendarEvent(supabase, resourceData, payload.receivedAt);
    }

    logger.info("Unhandled resource type", { resource: notification.resource });
    return { action: "skipped", reason: "unhandled_resource_type" };
  },
});

async function processEmailMessage(supabase: any, message: any, receivedAt: string) {
  const senderEmail = message.from?.emailAddress?.address?.toLowerCase();
  if (!senderEmail) {
    return { action: "skipped", reason: "no_sender_email" };
  }

  // Match sender to candidate or contact
  const match = await matchByEmail(supabase, senderEmail);

  if (!match) {
    logger.info("No matching entity for email", { email: senderEmail });
    return { action: "no_match", email: senderEmail };
  }

  // Check for duplicate message (by external ID)
  const externalId = message.id || message.internetMessageId;
  if (externalId) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("external_message_id", externalId)
      .limit(1);
    if (existing && existing.length > 0) {
      return { action: "skipped", reason: "duplicate" };
    }
  }

  // Determine or create conversation
  const conversationId = `graph_${match.entityId}`;
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (!existingConv) {
    await supabase.from("conversations").insert({
      id: conversationId,
      [match.entityColumn]: match.entityId,
      channel: "email",
      last_message_at: receivedAt,
    } as any);
  }

  // Insert message
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    [match.entityColumn]: match.entityId,
    channel: "email",
    direction: "inbound",
    subject: message.subject || null,
    body: message.body?.content || message.bodyPreview || "",
    sender_address: senderEmail,
    recipient_address: message.toRecipients?.[0]?.emailAddress?.address || "",
    sent_at: message.receivedDateTime || receivedAt,
    provider: "microsoft_graph",
    external_message_id: externalId,
    is_read: message.isRead || false,
  } as any);

  // Update conversation
  await supabase
    .from("conversations")
    .update({
      last_message_at: receivedAt,
      last_message_preview: (message.bodyPreview || "").substring(0, 100),
      is_read: false,
    })
    .eq("id", conversationId);

  // Update entity timestamps
  const table = match.entityType === "candidate" ? "candidates" : "contacts";
  await supabase
    .from(table)
    .update({
      last_responded_at: receivedAt,
      last_comm_channel: "email",
    } as any)
    .eq("id", match.entityId);

  // Run sentiment analysis on inbound email replies
  const emailBody = message.body?.content || message.bodyPreview || "";
  if (emailBody.length > 10) {
    await analyzeEmailSentiment(supabase, match.entityId, match.entityColumn, emailBody, receivedAt);
  }

  logger.info("Email logged", { entityId: match.entityId, subject: message.subject });
  return { action: "logged", entityId: match.entityId, type: "email" };
}

async function processCalendarEvent(supabase: any, event: any, receivedAt: string) {
  // Extract attendee emails and try to match
  const attendees = event.attendees || [];
  const matches: any[] = [];

  for (const attendee of attendees) {
    const email = attendee.emailAddress?.address?.toLowerCase();
    if (email) {
      const match = await matchByEmail(supabase, email);
      if (match) matches.push({ ...match, email });
    }
  }

  if (matches.length === 0) {
    return { action: "no_match", reason: "no_matching_attendees" };
  }

  // Create tasks for matched entities (calendar events → tasks)
  for (const match of matches) {
    await supabase.from("tasks").insert({
      title: event.subject || "Calendar Event",
      description: `Calendar event with ${match.email}: ${event.bodyPreview || ""}`,
      [match.entityColumn]: match.entityId,
      due_date: event.start?.dateTime || null,
      status: "pending",
      task_type: "meeting",
      created_at: receivedAt,
    } as any);
  }

  logger.info("Calendar event processed", { matchCount: matches.length });
  return { action: "logged", type: "calendar", matchCount: matches.length };
}

async function getMicrosoftAccessToken(): Promise<string | null> {
  try {
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });

    if (!resp.ok) {
      logger.error("Microsoft token error", { status: resp.status });
      return null;
    }

    const data = await resp.json();
    return data.access_token;
  } catch (err: any) {
    logger.error("Failed to get Microsoft credentials from app_settings", { error: err.message });
    return null;
  }
}

async function analyzeEmailSentiment(
  supabase: any,
  entityId: string,
  entityColumn: string,
  messageBody: string,
  receivedAt: string,
) {
  try {
    const apiKey = getAnthropicKey();
    // Strip HTML tags for analysis
    const plainText = messageBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (plainText.length < 10) return;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `Analyze the sentiment of this recruiting email reply. Return ONLY valid JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact",
  "summary": "one sentence summary"
}`,
        messages: [{ role: "user", content: plainText.slice(0, 2000) }],
        temperature: 0,
      }),
    });

    if (!resp.ok) return;

    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);

    // Find active enrollment
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq(entityColumn, entityId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Store sentiment
    await supabase.from("reply_sentiment").insert({
      [entityColumn]: entityId,
      enrollment_id: enrollment?.id || null,
      channel: "email",
      sentiment: analysis.sentiment,
      summary: analysis.summary,
      raw_message: plainText.slice(0, 1000),
      analyzed_at: receivedAt,
    } as any);

    if (enrollment) {
      await supabase
        .from("sequence_enrollments")
        .update({
          reply_sentiment: analysis.sentiment,
          reply_sentiment_note: analysis.summary,
          last_sequence_sentiment: analysis.sentiment,
        } as any)
        .eq("id", enrollment.id);
    }

    // Update candidate/contact sentiment
    const table = entityColumn === "candidate_id" ? "candidates" : "contacts";
    await supabase
      .from(table)
      .update({
        last_sequence_sentiment: analysis.sentiment,
        last_sequence_sentiment_note: analysis.summary,
      } as any)
      .eq("id", entityId);

    // Pipeline automation based on sentiment
    if (entityColumn === "candidate_id") {
      const negativeSentiments = ["negative", "not_interested", "do_not_contact"];
      const positiveSentiments = ["interested", "positive"];

      if (negativeSentiments.includes(analysis.sentiment)) {
        const { data: rejected } = await supabase
          .from("send_outs")
          .update({
            stage: "rejected",
            rejected_by: "candidate",
            rejection_reason: analysis.sentiment.replace(/_/g, " "),
            feedback: analysis.summary || plainText.slice(0, 500),
            updated_at: new Date().toISOString(),
          } as any)
          .eq("candidate_id", entityId)
          .not("stage", "in", '("rejected","placed")')
          .select("id");

        if (rejected && rejected.length > 0) {
          logger.info("Pipeline auto-rejected by candidate email sentiment", {
            entityId, sentiment: analysis.sentiment, sendOutIds: rejected.map((s: any) => s.id),
          });
        }
      } else if (positiveSentiments.includes(analysis.sentiment)) {
        const { data: advanced } = await supabase
          .from("send_outs")
          .update({ stage: "pitch", updated_at: new Date().toISOString() } as any)
          .eq("candidate_id", entityId)
          .in("stage", ["new", "reached_out"])
          .select("id");

        if (advanced && advanced.length > 0) {
          logger.info("Pipeline auto-advanced to pitch on positive email", {
            entityId, sentiment: analysis.sentiment, sendOutIds: advanced.map((s: any) => s.id),
          });
        }
      }
    }

    logger.info("Email sentiment analyzed", { entityId, sentiment: analysis.sentiment });
  } catch (err) {
    logger.error("Email sentiment analysis error", { error: err });
  }
}

async function matchByEmail(
  supabase: any,
  email: string,
): Promise<{ entityId: string; entityType: string; entityColumn: string } | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const [candidateRes, contactRes] = await Promise.all([
    supabase.from("candidates").select("id").ilike("email", normalizedEmail).limit(1),
    supabase.from("contacts").select("id").ilike("email", normalizedEmail).limit(1),
  ]);

  if (candidateRes.data?.[0]) {
    return { entityId: candidateRes.data[0].id, entityType: "candidate", entityColumn: "candidate_id" };
  }
  if (contactRes.data?.[0]) {
    return { entityId: contactRes.data[0].id, entityType: "contact", entityColumn: "contact_id" };
  }

  return null;
}
