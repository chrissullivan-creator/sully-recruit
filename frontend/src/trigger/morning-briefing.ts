import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getMicrosoftGraphCredentials } from "./lib/supabase";

/**
 * Morning briefing — gathers overnight activity, generates an AI-powered
 * summary email, and sends to Chris + Nancy via Microsoft Graph.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: morning-briefing
 *   Cron: 0 12 * * 1-5 (weekdays noon UTC = 8 AM ET)
 */

const BRIEFING_RECIPIENTS = [
  { name: "Chris Sullivan", email: "chris.sullivan@emeraldrecruit.com" },
  { name: "Nancy Eberlein", email: "nancy.eberlein@emeraldrecruit.com" },
];
const FROM_EMAIL = "chris.sullivan@emeraldrecruit.com";
const FROM_USER_ID = "fc07e240-0e31-45d4-a8f1-ddec1042dd5f";

async function getMSToken(supabase: any): Promise<string | null> {
  // Try stored oauth token first
  const { data: token } = await supabase
    .from("user_oauth_tokens")
    .select("access_token, expires_at")
    .eq("user_id", FROM_USER_ID)
    .eq("provider", "microsoft")
    .maybeSingle();

  if (token?.access_token && new Date(token.expires_at) > new Date(Date.now() + 60_000)) {
    return token.access_token;
  }

  // Fall back to client credentials
  const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();
  if (!clientId || !clientSecret || !tenantId) return null;

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}

async function sendEmail(
  accessToken: string,
  to: Array<{ name: string; email: string }>,
  subject: string,
  htmlBody: string,
) {
  const message = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: to.map((r) => ({ emailAddress: { address: r.email, name: r.name } })),
  };

  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${FROM_EMAIL}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph sendMail ${res.status}: ${err.slice(0, 200)}`);
  }
}

async function gatherBriefingData(supabase: any) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 1. New replies in last 24h with sentiment
  const { data: replies } = await supabase
    .from("reply_sentiment")
    .select(
      "sentiment, summary, channel, analyzed_at, candidate_id, contact_id, candidates(full_name, current_title, current_company), contacts(full_name, title, company_name)",
    )
    .gte("analyzed_at", yesterday)
    .order("analyzed_at", { ascending: false })
    .limit(50);

  const hotReplies = (replies ?? []).filter((r: any) =>
    ["interested", "positive"].includes(r.sentiment),
  );
  const doNotContact = (replies ?? []).filter((r: any) => r.sentiment === "do_not_contact");

  // 2. Call notes from last 24h
  const { data: callNotes } = await supabase
    .from("ai_call_notes")
    .select(
      "ai_summary, ai_action_items, call_duration_formatted, candidate_id, contact_id, created_at, candidates(full_name), contacts(full_name)",
    )
    .gte("created_at", yesterday)
    .order("created_at", { ascending: false })
    .limit(20);

  // 3. Active jobs
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, title, company_name, status")
    .eq("status", "open")
    .limit(20);

  // 4. Hot pipeline
  const { data: hotPipeline } = await supabase
    .from("candidate_jobs")
    .select(
      "pipeline_stage, stage_updated_at, candidates(full_name, current_title, current_company), jobs(title, company_name)",
    )
    .in("pipeline_stage", [
      "interviewing", "offer", "first_round", "second_round", "third_plus_round", "submitted",
    ])
    .order("stage_updated_at", { ascending: false })
    .limit(20);

  // 5. Sequence activity
  const { data: sequenceActivity } = await supabase
    .from("sequence_step_executions")
    .select("status, channel, executed_at")
    .gte("executed_at", yesterday)
    .neq("status", "skipped");

  const seqSent = (sequenceActivity ?? []).filter((s: any) => s.status === "sent").length;
  const seqFailed = (sequenceActivity ?? []).filter((s: any) => s.status === "failed").length;
  const seqByChannel = (sequenceActivity ?? []).reduce((acc: any, s: any) => {
    if (s.status === "sent") acc[s.channel] = (acc[s.channel] ?? 0) + 1;
    return acc;
  }, {});

  // 6. New candidates
  const { count: newCandidates } = await supabase
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .gte("created_at", yesterday);

  // 7. New embeddings
  const { count: newEmbeddings } = await supabase
    .from("resume_embeddings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", yesterday);

  // 8. Pending resumes
  const { count: pendingResumes } = await supabase
    .from("resumes")
    .select("id", { count: "exact", head: true })
    .not("candidate_id", "is", null)
    .or("raw_text.is.null,raw_text.eq.")
    .not("parsing_status", "in", '("failed","skipped","completed","parsed")');

  return {
    date: now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    replies: replies ?? [],
    hotReplies,
    doNotContact,
    callNotes: callNotes ?? [],
    jobs: jobs ?? [],
    hotPipeline: hotPipeline ?? [],
    sequenceStats: { sent: seqSent, failed: seqFailed, byChannel: seqByChannel },
    newCandidates: newCandidates ?? 0,
    newEmbeddings: newEmbeddings ?? 0,
    pendingResumes: pendingResumes ?? 0,
  };
}

async function generateBriefing(
  data: Awaited<ReturnType<typeof gatherBriefingData>>,
): Promise<string> {
  const anthropicKey = await getAnthropicKey();

  const system = `You are Joe — AI backbone of Sully Recruit, a Wall Street recruiting firm. Write a sharp, punchy morning briefing email for Chris Sullivan (President) and Nancy Eberlein (Managing Director).

Format as clean HTML email. Use <h2> for sections. Keep it tight — this is a 2-minute read, not a report. Lead with what matters most today.

Sections to include (skip any with zero activity):
1. Hot Leads (replied + interested/positive in last 24h) — name, firm, sentiment, what they said
2. Calls Yesterday — who, summary, action items
3. Pipeline Updates — candidates in late stages (interviews, offers)
4. Outreach Yesterday — sequence steps fired by channel
5. Do Not Contact — anyone who asked to stop (URGENT flag)
6. Database Health — new candidates, resumes parsed, pending

Tone: Joe. Direct. No corporate filler. Occasional wit. Make it a pleasure to read over coffee.
End with one sharp line of Joe commentary on the day ahead.

Do not include a To/From header — just the HTML body content starting with a greeting.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system,
      messages: [
        {
          role: "user",
          content: `Date: ${data.date}\n\nDATA:\n${JSON.stringify(
            {
              hot_replies: data.hotReplies.slice(0, 10).map((r: any) => ({
                name: r.candidates?.full_name ?? r.contacts?.full_name ?? "Unknown",
                firm: r.candidates?.current_company ?? r.contacts?.company_name ?? "",
                channel: r.channel,
                sentiment: r.sentiment,
                summary: r.summary,
              })),
              do_not_contact: data.doNotContact.map((r: any) => ({
                name: r.candidates?.full_name ?? r.contacts?.full_name ?? "Unknown",
                summary: r.summary,
              })),
              all_replies: {
                total: data.replies.length,
                hot: data.hotReplies.length,
                dnc: data.doNotContact.length,
              },
              call_notes: data.callNotes.slice(0, 5).map((c: any) => ({
                name: c.candidates?.full_name ?? c.contacts?.full_name ?? "Unknown",
                duration: c.call_duration_formatted,
                summary: c.ai_summary,
                action_items: c.ai_action_items,
              })),
              pipeline: data.hotPipeline.slice(0, 10).map((p: any) => ({
                candidate: p.candidates?.full_name,
                stage: p.pipeline_stage,
                job: p.jobs?.title,
                firm: p.jobs?.company_name,
              })),
              sequence_stats: data.sequenceStats,
              db_health: {
                new_candidates: data.newCandidates,
                resumes_parsed_24h: data.newEmbeddings,
                resumes_pending_parse: data.pendingResumes,
                open_jobs: data.jobs.length,
              },
            },
            null,
            2,
          )}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const result = await res.json();
  return result.content?.[0]?.text ?? "<p>Briefing generation failed.</p>";
}

export const morningBriefing = schedules.task({
  id: "morning-briefing",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    logger.info("Gathering briefing data...");
    const data = await gatherBriefingData(supabase);

    logger.info("Generating briefing with Claude...");
    const htmlContent = await generateBriefing(data);

    const subject = `Emerald Morning Briefing — ${data.date}`;

    // Send via Microsoft Graph
    const accessToken = await getMSToken(supabase);
    let sent = false;
    if (!accessToken) {
      logger.warn("No MS token — storing but not emailing");
    } else {
      await sendEmail(accessToken, BRIEFING_RECIPIENTS, subject, htmlContent);
      sent = true;
      logger.info(`Sent to ${BRIEFING_RECIPIENTS.map((r) => r.email).join(", ")}`);
    }

    // Store in morning_briefings table
    await supabase.from("morning_briefings").insert({
      briefing_date: new Date().toISOString().split("T")[0],
      content: htmlContent,
      sent_to: sent ? BRIEFING_RECIPIENTS.map((r) => r.email) : [],
      sent_at: sent ? new Date().toISOString() : null,
    });

    return {
      sent,
      sentTo: sent ? BRIEFING_RECIPIENTS.map((r) => r.email) : [],
      hotLeads: data.hotReplies.length,
      calls: data.callNotes.length,
      totalReplies: data.replies.length,
    };
  },
});
