import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

interface GenerateJoeSaysPayload {
  entityId: string;
  entityType: "candidate" | "contact";
}

const CANDIDATE_PROMPT = `You are Joe — the AI backbone of Sully Recruit, a Wall Street-focused recruiting CRM for The Emerald Recruiting Group. You place talent at hedge funds, investment banks, prop trading firms, asset managers, and financial services firms.

You are generating a comprehensive, recruiter-ready brief for a candidate. This brief should be the single source of truth that a recruiter can read to immediately understand everything about this candidate — their background, strengths, preferences, red flags, and how to pitch them.

Structure your summary as follows:

## Professional Overview
2-3 sentences capturing who this person is professionally — their trajectory, domain, and level.

## Current Situation
Current role, company, and what they're doing. Why they're looking (if known). Notice period/availability.

## Compensation
Current comp (base, bonus, total) and target comp. Any deferred comp, RSUs, or other considerations.

## Career History Highlights
Key roles and career moves — focus on what makes them placeable, not a resume dump.

## Education
Degrees, institutions, certifications — brief.

## Skills & Strengths
Technical skills, domain expertise, soft skills that came through in conversations.

## Preferences & Requirements
Work authorization, relocation, target locations, target roles, remote/hybrid preferences.

## Communication History
Summary of outreach and responses. Sentiment. Last contact. What channels have been used.

## Interview Readiness & Red Flags
Anything a recruiter should know before pitching — gaps, concerns, deal-breakers, or things that make them a slam dunk.

## Recruiter Talking Points
3-5 bullet points for pitching this candidate to a client.

Rules:
- Be concise and factual. Don't embellish or invent data.
- If data is missing for a section, say "No data available" rather than making things up.
- Use the candidate's actual words from call transcripts when relevant.
- Keep the tone sharp and professional — this is a working document, not marketing copy.`;

const CONTACT_PROMPT = `You are Joe — the AI backbone of Sully Recruit, a Wall Street-focused recruiting CRM for The Emerald Recruiting Group. You place talent at hedge funds, investment banks, prop trading firms, asset managers, and financial services firms.

You are generating a comprehensive brief for a client-side contact. This brief should help recruiters understand the relationship, hiring patterns, and how to work with this person effectively.

Structure your summary as follows:

## Contact Overview
Who this person is — title, company, role in the hiring process.

## Relationship History
How long we've been working with them, key interactions, sentiment.

## Hiring Activity
Jobs they've been involved in, candidates sent their way, placement history.

## Communication History
Summary of all back-and-forth — emails, calls, LinkedIn. Last contact and sentiment.

## Working Style & Preferences
What we know about how they like to work, response patterns, communication preferences.

## Key Notes
Important details from recruiter notes — preferences, pet peeves, decision-making style.

## Recruiter Action Items
What should we be doing with this contact right now?

Rules:
- Be concise and factual. Don't embellish or invent data.
- If data is missing for a section, say "No data available" rather than making things up.
- Keep the tone sharp and professional.`;

export const generateJoeSays = task({
  id: "generate-joe-says",
  retry: { maxAttempts: 2 },
  run: async (payload: GenerateJoeSaysPayload) => {
    const { entityId, entityType } = payload;
    const supabase = getSupabaseAdmin();
    const anthropicKey = await getAnthropicKey();

    logger.info("Generating Joe Says", { entityId, entityType });

    let contextParts: string[] = [];
    let systemPrompt: string;

    if (entityType === "candidate") {
      systemPrompt = CANDIDATE_PROMPT;
      contextParts = await gatherCandidateContext(supabase, entityId);
    } else {
      systemPrompt = CONTACT_PROMPT;
      contextParts = await gatherContactContext(supabase, entityId);
    }

    const contextText = contextParts.join("\n\n---\n\n");

    if (contextText.length < 50) {
      logger.info("Not enough data to generate summary", { entityId });
      return { skipped: true, reason: "insufficient_data" };
    }

    // Call Claude
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Generate a comprehensive brief for this ${entityType} based on all available data:\n\n${contextText.slice(0, 30000)}`,
          },
        ],
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error("Claude API error", { error: errText });
      throw new Error(`Claude API error: ${resp.status}`);
    }

    const data = await resp.json();
    const summary = data.content?.[0]?.text || "";

    if (!summary) {
      throw new Error("Empty response from Claude");
    }

    // Save to database
    const table = entityType === "candidate" ? "candidates" : "contacts";
    const { error: updateError } = await supabase
      .from(table)
      .update({
        joe_says: summary,
        joe_says_updated_at: new Date().toISOString(),
      } as any)
      .eq("id", entityId);

    if (updateError) {
      logger.error("Failed to save Joe Says", { error: updateError.message });
      throw new Error(`DB update failed: ${updateError.message}`);
    }

    logger.info("Joe Says generated successfully", {
      entityId,
      entityType,
      summaryLength: summary.length,
    });

    return { success: true, entityId, entityType, summaryLength: summary.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// GATHER CANDIDATE CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

async function gatherCandidateContext(supabase: any, candidateId: string): Promise<string[]> {
  const parts: string[] = [];

  // 1. Candidate profile
  const { data: candidate } = await supabase
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .single();

  if (candidate) {
    parts.push(`CANDIDATE PROFILE:
Name: ${candidate.first_name ?? ""} ${candidate.last_name ?? ""}
Email: ${candidate.email ?? "—"}
Phone: ${candidate.phone ?? "—"}
Title: ${candidate.current_title ?? "—"}
Company: ${candidate.current_company ?? "—"}
Location: ${candidate.location_text ?? "—"}
LinkedIn: ${candidate.linkedin_url ?? "—"}
Status: ${candidate.status ?? "—"}
Stage: ${candidate.stage ?? "—"}
Skills: ${candidate.skills?.join(", ") ?? "—"}
Work Authorization: ${candidate.work_authorization ?? "—"}
Relocation: ${candidate.relocation_preference ?? "—"}
Target Locations: ${candidate.target_locations ?? "—"}
Target Roles: ${candidate.target_roles ?? "—"}
Reason for Leaving: ${candidate.reason_for_leaving ?? "—"}
Current Base Comp: ${candidate.current_base_comp ?? "—"}
Current Bonus: ${candidate.current_bonus_comp ?? "—"}
Current Total Comp: ${candidate.current_total_comp ?? "—"}
Target Base: ${candidate.target_base_comp ?? "—"}
Target Total: ${candidate.target_total_comp ?? "—"}
Comp Notes: ${candidate.comp_notes ?? "—"}
Candidate Summary: ${candidate.candidate_summary ?? "—"}
Back of Resume Notes: ${candidate.back_of_resume_notes ?? "—"}
Last Contacted: ${candidate.last_contacted_at ?? "—"}
Last Response: ${candidate.last_responded_at ?? "—"}
Last Channel: ${candidate.last_comm_channel ?? "—"}
Sentiment: ${candidate.last_sequence_sentiment ?? "—"}`);
  }

  // 2. Work history
  const { data: workHistory } = await supabase
    .from("candidate_work_history")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("start_date", { ascending: false });

  if (workHistory?.length) {
    const workLines = workHistory.map(
      (w: any) =>
        `- ${w.title} at ${w.company_name} (${w.start_date ?? "?"} — ${w.is_current ? "Present" : w.end_date ?? "?"})${w.description ? `: ${w.description}` : ""}`,
    );
    parts.push(`WORK HISTORY:\n${workLines.join("\n")}`);
  }

  // 3. Education
  const { data: education } = await supabase
    .from("candidate_education")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("start_year", { ascending: false });

  if (education?.length) {
    const eduLines = education.map(
      (e: any) =>
        `- ${e.institution}: ${e.degree ?? ""}${e.degree && e.field_of_study ? " in " : ""}${e.field_of_study ?? ""} (${e.start_year ?? "?"} — ${e.end_year ?? "?"})`,
    );
    parts.push(`EDUCATION:\n${eduLines.join("\n")}`);
  }

  // 4. Notes (recruiter-entered)
  const { data: notes } = await supabase
    .from("notes")
    .select("note, created_at")
    .eq("entity_id", candidateId)
    .eq("entity_type", "candidate")
    .order("created_at", { ascending: false })
    .limit(20);

  if (notes?.length) {
    const noteLines = notes.map(
      (n: any) => `[${n.created_at}] ${stripHtml(n.note).slice(0, 500)}`,
    );
    parts.push(`RECRUITER NOTES:\n${noteLines.join("\n\n")}`);
  }

  // 5. Call logs with summaries
  const { data: callLogs } = await supabase
    .from("call_logs")
    .select("direction, started_at, duration_seconds, summary, notes")
    .eq("candidate_id", candidateId)
    .order("started_at", { ascending: false })
    .limit(15);

  if (callLogs?.length) {
    const callLines = callLogs.map((c: any) => {
      const dur = c.duration_seconds
        ? `${Math.floor(c.duration_seconds / 60)}:${(c.duration_seconds % 60).toString().padStart(2, "0")}`
        : "—";
      return `[${c.started_at}] ${c.direction} call (${dur})${c.summary ? `\nSummary: ${c.summary}` : ""}${c.notes ? `\nNotes: ${c.notes}` : ""}`;
    });
    parts.push(`CALL HISTORY:\n${callLines.join("\n\n")}`);
  }

  // 6. Recent conversations/messages
  const { data: conversations } = await supabase
    .from("conversations")
    .select("channel, subject, last_message_at, last_message_preview")
    .eq("candidate_id", candidateId)
    .order("last_message_at", { ascending: false })
    .limit(10);

  if (conversations?.length) {
    const convLines = conversations.map(
      (c: any) =>
        `[${c.last_message_at}] ${c.channel}${c.subject ? ` — ${c.subject}` : ""}: ${c.last_message_preview ?? ""}`,
    );
    parts.push(`COMMUNICATIONS:\n${convLines.join("\n")}`);
  }

  // 7. Resumes (parsed data)
  const { data: resumes } = await supabase
    .from("resumes")
    .select("ai_summary, parsed_json")
    .eq("candidate_id", candidateId)
    .eq("parse_status", "completed")
    .order("created_at", { ascending: false })
    .limit(1);

  if (resumes?.[0]) {
    const r = resumes[0];
    if (r.ai_summary) {
      parts.push(`RESUME AI SUMMARY:\n${r.ai_summary}`);
    }
    if (r.parsed_json && typeof r.parsed_json === "object") {
      parts.push(`PARSED RESUME DATA:\n${JSON.stringify(r.parsed_json, null, 2).slice(0, 3000)}`);
    }
  }

  // 8. Send-outs / job assignments
  const { data: sendOuts } = await supabase
    .from("send_outs")
    .select("stage, created_at, jobs(title, company_name)")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (sendOuts?.length) {
    const soLines = sendOuts.map(
      (s: any) =>
        `- ${(s.jobs as any)?.title ?? "?"} at ${(s.jobs as any)?.company_name ?? "?"} — Stage: ${s.stage} (${s.created_at})`,
    );
    parts.push(`JOB SUBMISSIONS:\n${soLines.join("\n")}`);
  }

  // 9. Sequence enrollments
  const { data: enrollments } = await supabase
    .from("sequence_enrollments")
    .select("status, enrolled_at, stopped_reason, sequences(name, channel)")
    .eq("candidate_id", candidateId)
    .order("enrolled_at", { ascending: false })
    .limit(5);

  if (enrollments?.length) {
    const enrLines = enrollments.map(
      (e: any) =>
        `- ${(e.sequences as any)?.name ?? "?"} (${(e.sequences as any)?.channel ?? "?"}) — ${e.status}${e.stopped_reason ? ` (${e.stopped_reason})` : ""} — Enrolled ${e.enrolled_at}`,
    );
    parts.push(`SEQUENCE HISTORY:\n${enrLines.join("\n")}`);
  }

  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// GATHER CONTACT CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

async function gatherContactContext(supabase: any, contactId: string): Promise<string[]> {
  const parts: string[] = [];

  // 1. Contact profile
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single();

  if (contact) {
    parts.push(`CONTACT PROFILE:
Name: ${contact.first_name ?? ""} ${contact.last_name ?? ""}
Email: ${contact.email ?? "—"}
Phone: ${contact.phone ?? "—"}
Title: ${contact.title ?? "—"}
Company: ${contact.company_name ?? "—"}
Location: ${contact.location_text ?? "—"}
LinkedIn: ${contact.linkedin_url ?? "—"}
Status: ${contact.status ?? "—"}
Last Contacted: ${contact.last_contacted_at ?? "—"}
Last Response: ${contact.last_responded_at ?? "—"}
Sentiment: ${contact.last_sequence_sentiment ?? "—"}`);
  }

  // 2. Notes
  const { data: notes } = await supabase
    .from("notes")
    .select("note, created_at")
    .eq("entity_id", contactId)
    .eq("entity_type", "contact")
    .order("created_at", { ascending: false })
    .limit(20);

  if (notes?.length) {
    const noteLines = notes.map(
      (n: any) => `[${n.created_at}] ${stripHtml(n.note).slice(0, 500)}`,
    );
    parts.push(`RECRUITER NOTES:\n${noteLines.join("\n\n")}`);
  }

  // 3. Call logs
  const { data: callLogs } = await supabase
    .from("call_logs")
    .select("direction, started_at, duration_seconds, summary, notes")
    .eq("contact_id", contactId)
    .order("started_at", { ascending: false })
    .limit(15);

  if (callLogs?.length) {
    const callLines = callLogs.map((c: any) => {
      const dur = c.duration_seconds
        ? `${Math.floor(c.duration_seconds / 60)}:${(c.duration_seconds % 60).toString().padStart(2, "0")}`
        : "—";
      return `[${c.started_at}] ${c.direction} call (${dur})${c.summary ? `\nSummary: ${c.summary}` : ""}`;
    });
    parts.push(`CALL HISTORY:\n${callLines.join("\n\n")}`);
  }

  // 4. Conversations
  const { data: conversations } = await supabase
    .from("conversations")
    .select("channel, subject, last_message_at, last_message_preview")
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false })
    .limit(10);

  if (conversations?.length) {
    const convLines = conversations.map(
      (c: any) =>
        `[${c.last_message_at}] ${c.channel}${c.subject ? ` — ${c.subject}` : ""}: ${c.last_message_preview ?? ""}`,
    );
    parts.push(`COMMUNICATIONS:\n${convLines.join("\n")}`);
  }

  // 5. Send-outs (as hiring manager)
  const { data: sendOuts } = await supabase
    .from("send_outs")
    .select("stage, created_at, jobs(title, company_name), candidates(first_name, last_name)")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (sendOuts?.length) {
    const soLines = sendOuts.map(
      (s: any) =>
        `- ${(s.candidates as any)?.first_name ?? ""} ${(s.candidates as any)?.last_name ?? ""} → ${(s.jobs as any)?.title ?? "?"} — Stage: ${s.stage}`,
    );
    parts.push(`CANDIDATES SUBMITTED:\n${soLines.join("\n")}`);
  }

  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? "";
}
