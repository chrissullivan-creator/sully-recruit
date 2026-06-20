import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Microsoft Graph for sending emails
const MS_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID") ?? Deno.env.get("MICROSOFT_CLIENT_ID") ?? "";
const MS_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET") ?? Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "";
const MS_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") ?? Deno.env.get("MICROSOFT_TENANT_ID") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Recipients: Chris + Nancy
const BRIEFING_RECIPIENTS = [
  { name: "Chris Sullivan", email: "chris.sullivan@emeraldrecruit.com" },
  { name: "Nancy Eberlein", email: "nancy.eberlein@emeraldrecruit.com" },
];
const FROM_EMAIL = "chris.sullivan@emeraldrecruit.com";
const FROM_USER_ID = "fc07e240-0e31-45d4-a8f1-ddec1042dd5f";

// ── Microsoft Graph token ──────────────────────────────────────────
async function getMSToken(supabase: any): Promise<string | null> {
  // Try stored oauth token first
  const { data: token } = await supabase
    .from("user_oauth_tokens")
    .select("access_token, expires_at")
    .eq("user_id", FROM_USER_ID)
    .eq("provider", "microsoft")
    .maybeSingle();

  if (token?.access_token && new Date(token.expires_at) > new Date(Date.now() + 60000)) {
    return token.access_token;
  }

  // Fall back to client credentials
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET || !MS_TENANT_ID) return null;

  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}

async function sendEmail(accessToken: string, to: Array<{ name: string; email: string }>, subject: string, htmlBody: string) {
  const message = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: to.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
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

// ── Gather all the data for the briefing ─────────────────────────────
async function gatherBriefingData(supabase: any) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1. New replies in last 24h with sentiment
  const { data: replies } = await supabase
    .from("reply_sentiment")
    .select("sentiment, summary, channel, analyzed_at, candidate_id, contact_id, candidates(full_name, current_title, current_company), contacts(full_name, title, company_name)")
    .gte("analyzed_at", yesterday)
    .order("analyzed_at", { ascending: false })
    .limit(50);

  // 2. Interested / positive replies specifically (hot leads)
  const hotReplies = (replies ?? []).filter((r: any) => ["interested", "positive"].includes(r.sentiment));
  const doNotContact = (replies ?? []).filter((r: any) => r.sentiment === "do_not_contact");

  // 3. Call notes from last 24h
  const { data: callNotes } = await supabase
    .from("ai_call_notes")
    .select("ai_summary, ai_action_items, call_duration_formatted, candidate_id, contact_id, created_at, candidates(full_name), contacts(full_name)")
    .gte("created_at", yesterday)
    .order("created_at", { ascending: false })
    .limit(20);

  // 4. Active jobs with pipeline activity
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, title, company_name, status")
    .eq("status", "open")
    .limit(20);

  // 5. Candidates in late pipeline stages
  const { data: hotPipeline } = await supabase
    .from("candidate_jobs")
    .select("pipeline_stage, stage_updated_at, candidates(full_name, current_title, current_company), jobs(title, company_name)")
    .in("pipeline_stage", ["interviewing", "offer", "first_round", "second_round", "third_plus_round", "submitted"])
    .order("stage_updated_at", { ascending: false })
    .limit(20);

  // 6. Sequence activity: steps fired yesterday
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

  // 7. New candidates added yesterday
  const { count: newCandidates } = await supabase
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .gte("created_at", yesterday);

  // 8. New embeddings (resume parsing progress)
  const { count: newEmbeddings } = await supabase
    .from("resume_embeddings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", yesterday);

  // 9. Resumes still pending parse
  const { count: pendingResumes } = await supabase
    .from("resumes")
    .select("id", { count: "exact", head: true })
    .not("candidate_id", "is", null)
    .or("raw_text.is.null,raw_text.eq.")
    .not("parsing_status", "in", '("failed","skipped","completed","parsed")');

  return {
    date: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
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

// ── Generate briefing HTML with Claude ────────────────────────────
async function generateBriefing(data: Awaited<ReturnType<typeof gatherBriefingData>>): Promise<string> {
  const system = `You are Joe — AI backbone of Sully Recruit, a Wall Street recruiting firm. Write a sharp, punchy morning briefing email for Chris Sullivan (President) and Nancy Eberlein (Managing Director).

Format as clean HTML email. Use <h2> for sections. Keep it tight — this is a 2-minute read, not a report. Lead with what matters most today.

Sections to include (skip any with zero activity):
1. 🔥 Hot Leads (replied + interested/positive in last 24h) — name, firm, sentiment, what they said
2. 📞 Calls Yesterday — who, summary, action items
3. 🎯 Pipeline Updates — candidates in late stages (interviews, offers)
4. 📤 Outreach Yesterday — sequence steps fired by channel
5. ⚠️ Do Not Contact — anyone who asked to stop (URGENT flag)
6. 🛠️ Database Health — new candidates, resumes parsed, pending

Tone: Joe. Direct. No corporate filler. Occasional wit. Make it a pleasure to read over coffee.
End with one sharp line of Joe commentary on the day ahead.

Do not include a To/From header — just the HTML body content starting with a greeting.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system,
      messages: [{
        role: "user",
        content: `Date: ${data.date}\n\nDATA:\n${JSON.stringify({
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
          all_replies: { total: data.replies.length, hot: data.hotReplies.length, dnc: data.doNotContact.length },
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
        }, null, 2)}`,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const result = await res.json();
  return result.content?.[0]?.text ?? "<p>Briefing generation failed.</p>";
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const preview = body.preview ?? false; // return HTML without sending email

    // Gather data
    console.log("[morning-briefing] gathering data...");
    const data = await gatherBriefingData(supabase);

    // Generate briefing
    console.log("[morning-briefing] generating with Claude...");
    const htmlContent = await generateBriefing(data);

    const subject = `📈 Emerald Morning Briefing — ${data.date}`;

    if (preview) {
      return new Response(htmlContent, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
    }

    // Send via Microsoft Graph
    const accessToken = await getMSToken(supabase);
    if (!accessToken) {
      // Log but don’t fail — store briefing regardless
      console.warn("[morning-briefing] no MS token, storing but not emailing");
    } else {
      await sendEmail(accessToken, BRIEFING_RECIPIENTS, subject, htmlContent);
      console.log("[morning-briefing] sent to", BRIEFING_RECIPIENTS.map(r => r.email).join(", "));
    }

    // Store in morning_briefings table
    await supabase.from("morning_briefings").insert({
      briefing_date: new Date().toISOString().split("T")[0],
      content: htmlContent,
      sent_to: accessToken ? BRIEFING_RECIPIENTS.map(r => r.email) : [],
      sent_at: accessToken ? new Date().toISOString() : null,
    });

    return respond({
      success: true,
      sent_to: BRIEFING_RECIPIENTS.map(r => r.email),
      hot_leads: data.hotReplies.length,
      calls: data.callNotes.length,
      total_replies: data.replies.length,
    });

  } catch (err: any) {
    console.error("[morning-briefing] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
