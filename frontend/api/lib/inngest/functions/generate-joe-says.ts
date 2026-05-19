import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getOpenRouterKey,
  getVoyageKey,
} from "../../../../src/trigger/lib/supabase.js";
import { callAIWithFallback } from "../../../../src/lib/ai-fallback.js";

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

## Call Insights
This is the highlight reel from recent calls — the recruiter wants this section to be specific, not generic. Use the data and call transcripts to fill in:
- **Reason looking for a new role:** Why are they exploring? Push or pull?
- **Where else interviewed / submitted:** Firms they're already in process with or other recruiters have submitted them to. Helps avoid double-submits.
- **What they want to do next:** Concrete direction — function, firm-type, products, level. Not a wishlist.
- **Dislikes about current role:** Specific complaints (manager, comp, scope, hours, growth). Verbatim where useful.
- **Current compensation:** Base / bonus / total — best numbers we have.
- **Expected compensation:** What they need / want / would jump for.
- **Relocation:** Target locations, willingness, family situation, blocked cities.
- **Visa / right to work:** Status (Citizen / GC / H-1B / OPT / etc.) and any sponsorship needs.
- **Job-move explanations:** Story for short stints, gaps, or lateral moves — pre-empt client objections.
- **Interesting facts:** Hobbies, family, connection points — anything to build rapport later.

If a bullet has no data, write "No data available" for that bullet — do not invent or imply.

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

/**
 * Generate the AI "Joe Says" brief for a candidate or contact and stamp
 * the result on `people.joe_says` / `contacts.joe_says`. Triggered after
 * any inbound communication or resume ingestion completes so the
 * recruiter-facing summary stays fresh.
 *
 * Concurrency keyed on `entityId` so chained triggers (a webhook call
 * + a resume parse landing in the same minute) don't blow Anthropic
 * tokens by computing the brief twice.
 *
 * Ported from `src/trigger/generate-joe-says.ts`. The Trigger.dev
 * `generateJoeSays` task remains as a thin pass-through that sends the
 * `ai/joe-says.requested` event so any caller still using
 * `generateJoeSays.trigger(...)` keeps working until they're migrated.
 */
export const generateJoeSays = inngest.createFunction(
  {
    id: "generate-joe-says",
    name: "Generate Joe Says brief (Inngest)",
    retries: 2,
    concurrency: [{ key: "event.data.entityId", limit: 1 }],
  },
  { event: "ai/joe-says.requested" },
  async ({ event, logger }) => {
    const { entityId, entityType } = event.data as GenerateJoeSaysPayload;
    const supabase = getSupabaseAdmin();
    const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getGeminiKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
    ]);

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

    const { text: summary } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt,
      userContent: `Generate a comprehensive brief for this ${entityType} based on all available data:\n\n${contextText.slice(0, 30000)}`,
      model: "claude-sonnet-4-6",
      maxTokens: 3000,
    });

    if (!summary) {
      throw new Error("Empty response from AI provider");
    }

    // Write to the people base table directly. The candidates VIEW
    // exposes joe_says (so legacy writes there worked) but the contacts
    // VIEW doesn't — and as the unified person model has a single base
    // table, hitting `people` is the source-of-truth path for both
    // entity types. This silently fixed contact-mode joe_says, which
    // had been failing every time the function fired for a contact.
    const { error: updateError } = await supabase
      .from("people")
      .update({
        joe_says: summary,
        joe_says_updated_at: new Date().toISOString(),
      } as any)
      .eq("id", entityId);

    if (updateError) {
      logger.error("Failed to save Joe Says", { error: updateError.message });
      throw new Error(`DB update failed: ${updateError.message}`);
    }

    // Embed the brief so Ask Joe's contact/candidate RAG can vector-match
    // on the full summary text (resume_embeddings covers candidate resumes
    // but not the recruiter-edited brief and not contacts at all).
    // Best-effort: a Voyage failure here doesn't block the brief save.
    try {
      const voyageKey = await getVoyageKey().catch(() => "");
      if (voyageKey) {
        const embedRes = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${voyageKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "voyage-finance-2",
            input: [summary.slice(0, 8000)],
            input_type: "document",
          }),
        });
        if (embedRes.ok) {
          const embedData = await embedRes.json();
          const vec = embedData?.data?.[0]?.embedding;
          if (Array.isArray(vec) && vec.length === 1024) {
            const vecLit = `[${vec.join(",")}]`;
            await supabase
              .from("people")
              .update({
                joe_says_embedding: vecLit,
                joe_says_embedded_at: new Date().toISOString(),
              } as any)
              .eq("id", entityId);
          } else {
            logger.warn("Voyage returned unexpected embedding shape", { entityId });
          }
        } else {
          const errBody = (await embedRes.text()).slice(0, 200);
          logger.warn("Voyage embed failed", { status: embedRes.status, body: errBody });
        }
      }
    } catch (err: any) {
      logger.warn("joe_says embedding step failed", { error: err?.message });
    }

    logger.info("Joe Says generated successfully", {
      entityId,
      entityType,
      summaryLength: summary.length,
    });

    return { success: true, entityId, entityType, summaryLength: summary.length };
  },
);

async function gatherCandidateContext(supabase: any, candidateId: string): Promise<string[]> {
  const parts: string[] = [];

  const { data: candidate } = await supabase
    .from("people")
    .select("*")
    .eq("id", candidateId)
    .single();

  if (candidate) {
    const structured = (candidate.call_structured_notes ?? {}) as Record<string, any>;
    parts.push(`CANDIDATE PROFILE:
Name: ${candidate.first_name ?? ""} ${candidate.last_name ?? ""}
Email: ${candidate.primary_email ?? candidate.personal_email ?? candidate.work_email ?? "—"}
Phone: ${candidate.phone ?? candidate.mobile_phone ?? "—"}
Title: ${candidate.current_title ?? "—"}
Company: ${candidate.current_company ?? "—"}
Location: ${candidate.location_text ?? "—"}
LinkedIn: ${candidate.linkedin_url ?? "—"}
Status: ${candidate.status ?? "—"}
Skills: ${Array.isArray(candidate.skills) ? candidate.skills.join(", ") : candidate.skills ?? "—"}
Work Authorization: ${candidate.work_authorization ?? "—"}
Visa Status: ${candidate.visa_status ?? "—"}
Relocation: ${candidate.relocation_preference ?? "—"}
Relocation Details: ${structured.relo_details ?? "—"}
Target Locations: ${candidate.target_locations ?? "—"}
Target Roles: ${candidate.target_roles ?? "—"}
Looking To Do Next: ${structured.looking_to_do_next ?? "—"}
Dislikes Current Role: ${structured.dislikes_current_role ?? "—"}
Job Move Explanations: ${structured.job_move_explanations ?? "—"}
Reason for Leaving: ${candidate.reason_for_leaving ?? "—"}
Where Interviewed: ${candidate.where_interviewed ?? "—"}
Where Submitted (other recruiters): ${candidate.where_submitted ?? "—"}
Notice Period: ${candidate.notice_period ?? "—"}
Current Base Comp: ${candidate.current_base_comp ?? "—"}
Current Bonus: ${candidate.current_bonus_comp ?? "—"}
Current Total Comp: ${candidate.current_total_comp ?? "—"}
Target Base: ${candidate.target_base_comp ?? "—"}
Target Total: ${candidate.target_total_comp ?? "—"}
Comp Notes: ${candidate.comp_notes ?? "—"}
Fun Facts: ${candidate.fun_facts ?? "—"}
Candidate Summary: ${candidate.candidate_summary ?? "—"}
Back of Resume Notes: ${candidate.back_of_resume_notes ?? "—"}
Last Contacted: ${candidate.last_contacted_at ?? "—"}
Last Response: ${candidate.last_responded_at ?? "—"}
Last Channel: ${candidate.last_comm_channel ?? "—"}
Sentiment: ${candidate.last_sequence_sentiment ?? "—"}`);
  }

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

  const { data: callLogs } = await supabase
    .from("call_logs")
    .select("direction, started_at, duration_seconds, summary, notes")
    .or(`candidate_id.eq.${candidateId},and(linked_entity_id.eq.${candidateId},linked_entity_type.eq.candidate)`)
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

  const { data: resumes } = await supabase
    .from("resumes")
    .select("ai_summary, parsed_json")
    .eq("candidate_id", candidateId)
    .eq("parsing_status", "completed")
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

  const { data: enrollments } = await supabase
    .from("sequence_enrollments")
    .select("status, enrolled_at, stop_reason, sequences(name, channel)")
    .eq("candidate_id", candidateId)
    .order("enrolled_at", { ascending: false })
    .limit(5);

  if (enrollments?.length) {
    const enrLines = enrollments.map(
      (e: any) =>
        `- ${(e.sequences as any)?.name ?? "?"} (${(e.sequences as any)?.channel ?? "?"}) — ${e.status}${e.stop_reason ? ` (${e.stop_reason})` : ""} — Enrolled ${e.enrolled_at}`,
    );
    parts.push(`SEQUENCE HISTORY:\n${enrLines.join("\n")}`);
  }

  return parts;
}

async function gatherContactContext(supabase: any, contactId: string): Promise<string[]> {
  const parts: string[] = [];

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

  const { data: callLogs } = await supabase
    .from("call_logs")
    .select("direction, started_at, duration_seconds, summary, notes")
    .or(`contact_id.eq.${contactId},and(linked_entity_id.eq.${contactId},linked_entity_type.eq.contact)`)
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

  const { data: sendOuts } = await supabase
    .from("send_outs")
    .select("stage, created_at, jobs(title, company_name), candidate:people!candidate_id(first_name, last_name)")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (sendOuts?.length) {
    const soLines = sendOuts.map(
      (s: any) =>
        `- ${(s.candidate as any)?.first_name ?? ""} ${(s.candidate as any)?.last_name ?? ""} → ${(s.jobs as any)?.title ?? "?"} — Stage: ${s.stage}`,
    );
    parts.push(`CANDIDATES SUBMITTED:\n${soLines.join("\n")}`);
  }

  return parts;
}

function stripHtml(html: string): string {
  return html?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? "";
}
