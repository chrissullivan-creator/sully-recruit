/**
 * AI-powered candidate/contact intelligence extraction.
 *
 * Runs on every inbound message (email, LinkedIn, SMS) to extract
 * recruiting-relevant details: compensation, motivation, location
 * preferences, skills, availability, etc.
 *
 * Extracted fields are written directly to the candidate/contact record
 * and appended to back_of_resume_notes for context preservation.
 */
import { logger } from "./logger.js";
import { getAnthropicKey, getOpenAIKey, getGeminiKey, getOpenRouterKey } from "./supabase.js";
import { callAIWithFallback } from "../lib/ai-fallback.js";
import { notifyError } from "./alerting.js";

interface ExtractedIntel {
  sentiment: string;
  summary: string;
  ooo_return_date: string | null;
  extracted_fields: {
    current_title?: string;
    current_company?: string;
    reason_for_looking?: string;
    current_base_comp?: string;
    current_total_comp?: string;
    target_base_comp?: string;
    target_total_comp?: string;
    comp_notes?: string;
    target_locations?: string;
    target_roles?: string;
    relocation_preference?: string;
    notice_period?: string;
    work_authorization?: string;
    availability_notes?: string;
    skills_mentioned?: string[];
  };
}

const EXTRACTION_PROMPT = `You are analyzing an inbound message from a recruiting conversation. Extract sentiment AND any recruiting-relevant details mentioned.

Return ONLY valid JSON:
{
  "sentiment": "interested|positive|maybe|neutral|negative|not_interested|do_not_contact|ooo",
  "summary": "one sentence summary of the message",
  "ooo_return_date": "YYYY-MM-DD or null if not OOO",
  "extracted_fields": {
    "current_title": "their current job title if mentioned, or null",
    "current_company": "their current employer if mentioned, or null",
    "reason_for_looking": "why they're open to new opportunities, or null",
    "current_base_comp": "current base salary if mentioned (e.g. '150k'), or null",
    "current_total_comp": "current total comp if mentioned (e.g. '200k all-in'), or null",
    "target_base_comp": "desired base salary if mentioned, or null",
    "target_total_comp": "desired total comp if mentioned, or null",
    "comp_notes": "any other compensation details (bonus, equity, etc.), or null",
    "target_locations": "preferred work locations if mentioned, or null",
    "target_roles": "types of roles they're interested in, or null",
    "relocation_preference": "willing to relocate? remote preference? or null",
    "notice_period": "how soon they can start, or null",
    "work_authorization": "visa status if mentioned, or null",
    "availability_notes": "scheduling preferences, best time to talk, or null",
    "skills_mentioned": ["any specific skills, certifications, or technologies mentioned"]
  }
}

Rules:
- Use "ooo" sentiment ONLY for auto-reply / out-of-office messages
- Use "do_not_contact" if they explicitly ask to stop all outreach
- Only populate extracted_fields with info EXPLICITLY stated in the message — never infer
- Set fields to null if not mentioned
- skills_mentioned should be an empty array if none mentioned
- For compensation, preserve the exact phrasing (e.g. "mid-100s base" not "150000")`;

/**
 * Analyze an inbound message for sentiment + extract candidate intelligence.
 * Returns null if analysis fails or message is too short.
 */
export async function extractMessageIntel(
  messageBody: string,
  messageSubject?: string | null,
): Promise<ExtractedIntel | null> {
  const plainText = (messageBody || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plainText.length < 10) return null;

  const fullText = messageSubject
    ? `Subject: ${messageSubject}\n\n${plainText}`
    : plainText;

  try {
    const [apiKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
      getAnthropicKey(), getOpenAIKey(), getGeminiKey(), getOpenRouterKey(),
    ]);
    const { text, via } = await callAIWithFallback({
      anthropicKey: apiKey,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt: EXTRACTION_PROMPT,
      userContent: fullText.slice(0, 3000),
      model: "claude-haiku-4-5-20251001",
      maxTokens: 500,
      jsonOutput: true,
    });

    // Strip markdown code fences the model sometimes wraps JSON in, then take
    // the outermost object. notifyError (not a silent logger.warn) on failure —
    // these two branches are how sentiment "quietly stopped working" for months:
    // a successful AI call returning non-JSON still produced a silent null with
    // no alert, so reply_sentiment went 0 rows for ~12 weeks unnoticed.
    const cleaned = text.replace(/```(?:json)?/gi, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await notifyError({
        taskId: "intel-extraction",
        error: new Error(`AI returned non-JSON via ${via}`),
        context: { via, snippet: text.slice(0, 300) },
        severity: "WARN",
      });
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]) as ExtractedIntel;
    } catch (parseErr: any) {
      await notifyError({
        taskId: "intel-extraction",
        error: new Error(`AI JSON parse failed via ${via}: ${parseErr.message}`),
        context: { via, snippet: jsonMatch[0].slice(0, 300) },
        severity: "WARN",
      });
      return null;
    }
  } catch (err: any) {
    // Surface the real upstream error (credit balance, OpenAI 401, etc.)
    // so we can see why sentiment stops working — silent null was masking it.
    await notifyError({
      taskId: "intel-extraction",
      error: err,
      context: { textLen: fullText.length, sample: fullText.slice(0, 120) },
    });
    return null;
  }
}

/**
 * Parse a free-text comp phrase the model extracted ("150k", "$150,000",
 * "1.5m", "mid-100s base") into a number of dollars, or null when it can't.
 * The people.*_comp + compensation_history.*_comp columns are numeric, so the
 * raw phrase can't be written directly — the exact wording is preserved in the
 * note / comp_notes instead. A bare number under 1000 is read as thousands
 * (comp context: "150" means 150k).
 */
export function parseComp(raw?: string | null): number | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[$,\s]/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)\s*(k|m)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  if (m[2] === "m") n *= 1_000_000;
  else if (m[2] === "k") n *= 1_000;
  else if (n < 1000) n *= 1_000;
  return Math.round(n);
}

// Sentiment values the DB accepts (reply_sentiment_sentiment_check). Clamp the
// model's output to this set so an off-vocab hallucination can't fail the insert.
const ALLOWED_SENTIMENTS = new Set([
  'positive', 'interested', 'neutral', 'negative', 'not_interested', 'maybe',
  'do_not_contact', 'ooo', 'booked_meeting',
]);

/**
 * Apply extracted intelligence to a candidate or contact record.
 * Only updates fields that were explicitly extracted (non-null).
 * Appends insights to back_of_resume_notes rather than overwriting.
 */
export async function applyExtractedIntel(
  supabase: any,
  entityId: string,
  entityType: "candidate" | "contact",
  intel: ExtractedIntel,
  channel: string,
  enrollmentId?: string | null,
) {
  const table = entityType === "candidate" ? "candidates" : "contacts";
  const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
  const fields = intel.extracted_fields;
  const safeSentiment = ALLOWED_SENTIMENTS.has(intel.sentiment as any) ? intel.sentiment : 'neutral';

  // Store sentiment in reply_sentiment table. Check the error instead of
  // swallowing it — an unchecked failed insert here would look identical to
  // "no sentiment" with zero signal.
  const { error: sentimentErr } = await supabase.from("reply_sentiment").insert({
    [entityColumn]: entityId,
    enrollment_id: enrollmentId || null,
    channel,
    sentiment: safeSentiment,
    summary: intel.summary,
    analyzed_at: new Date().toISOString(),
  } as any);
  if (sentimentErr) {
    await notifyError({
      taskId: "intel-extraction",
      error: sentimentErr,
      context: { stage: "reply_sentiment.insert", entityId, entityType, channel },
    });
  }

  // Update sentiment on enrollment if provided
  if (enrollmentId) {
    await supabase
      .from("sequence_enrollments")
      .update({
        reply_sentiment: safeSentiment,
        reply_sentiment_note: intel.summary,
      } as any)
      .eq("id", enrollmentId);
  }

  // Update sentiment on entity
  await supabase
    .from(table)
    .update({
      last_sequence_sentiment: safeSentiment,
      last_sequence_sentiment_note: intel.summary,
    } as any)
    .eq("id", entityId);

  // Compliance: an explicit "stop contacting me" suppresses ALL future
  // outreach, not just the current sequence. Set on the base people table so
  // the enrollment guard (enrollment-init-runner / sequence-runner) can refuse
  // to message them again. Reply-stop of the active enrollment is handled by
  // the webhook caller separately.
  if (safeSentiment === "do_not_contact") {
    await supabase
      .from("people")
      .update({ do_not_contact: true } as any)
      .eq("id", entityId);
  }

  // Build update object with only non-null extracted fields
  const updates: Record<string, any> = {};

  if (entityType === "candidate") {
    if (fields.current_title) updates.current_title = fields.current_title;
    if (fields.current_company) updates.current_company = fields.current_company;
    if (fields.reason_for_looking) updates.reason_for_leaving = fields.reason_for_looking;
    // The comp columns are numeric — parse the extracted phrase to a number.
    // The exact wording is kept in comp_notes / back_of_resume_notes below.
    const cBase = parseComp(fields.current_base_comp);
    const cTotal = parseComp(fields.current_total_comp);
    const tBase = parseComp(fields.target_base_comp);
    const tTotal = parseComp(fields.target_total_comp);
    if (cBase != null) updates.current_base_comp = cBase;
    if (cTotal != null) updates.current_total_comp = cTotal;
    if (tBase != null) updates.target_base_comp = tBase;
    if (tTotal != null) updates.target_total_comp = tTotal;
    if (fields.comp_notes) updates.comp_notes = fields.comp_notes;
    if (fields.target_locations) updates.target_locations = fields.target_locations;
    if (fields.target_roles) updates.target_roles = fields.target_roles;
    if (fields.relocation_preference) updates.relocation_preference = fields.relocation_preference;
    if (fields.notice_period) updates.notice_period = fields.notice_period;
    if (fields.work_authorization) updates.work_authorization = fields.work_authorization;
  } else {
    // Contacts have different field names
    if (fields.current_title) updates.title = fields.current_title;
    if (fields.current_company) updates.company_name = fields.current_company;
  }

  // Apply updates if any fields were extracted
  if (Object.keys(updates).length > 0) {
    await supabase.from(table).update(updates as any).eq("id", entityId);
    logger.info("Updated entity with extracted intel", {
      entityId,
      entityType,
      fieldsUpdated: Object.keys(updates),
    });
  }

  // Auto-snapshot comp to history whenever a conversation (call / email /
  // LinkedIn) surfaced comp, attributed to the candidate's owning recruiter, so
  // the trail of what they said over time builds itself — not just manual
  // entries. The exact phrasing is preserved in the note.
  if (entityType === "candidate") {
    const compMentioned =
      fields.current_base_comp || fields.current_total_comp ||
      fields.target_base_comp || fields.target_total_comp || fields.comp_notes;
    if (compMentioned) {
      try {
        const { data: owner } = await supabase
          .from("people")
          .select("owner_user_id")
          .eq("id", entityId)
          .maybeSingle();
        const phrases: string[] = [];
        if (fields.current_base_comp || fields.current_total_comp)
          phrases.push(`current ${fields.current_base_comp || "?"} base / ${fields.current_total_comp || "?"} total`);
        if (fields.target_base_comp || fields.target_total_comp)
          phrases.push(`asking ${fields.target_base_comp || "?"} base / ${fields.target_total_comp || "?"} total`);
        if (fields.comp_notes) phrases.push(fields.comp_notes);
        const note = `From ${channel} conversation: ${phrases.join("; ")}`.slice(0, 1000);
        const { error: snapErr } = await supabase.from("compensation_history").insert({
          person_id: entityId,
          current_base_comp: parseComp(fields.current_base_comp),
          current_total_comp: parseComp(fields.current_total_comp),
          target_base_comp: parseComp(fields.target_base_comp),
          target_total_comp: parseComp(fields.target_total_comp),
          note,
          created_by: (owner as any)?.owner_user_id ?? null,
        } as any);
        if (snapErr) {
          logger.warn("intel-extraction: comp_history snapshot failed", { entityId, error: snapErr.message });
        } else {
          logger.info("intel-extraction: comp_history snapshot written", { entityId, channel });
        }
      } catch (err: any) {
        logger.warn("intel-extraction: comp_history snapshot threw", { entityId, error: err?.message });
      }
    }
  }

  // Append to back_of_resume_notes (candidates only)
  if (entityType === "candidate") {
    const noteLines: string[] = [];
    if (fields.reason_for_looking) noteLines.push(`Looking because: ${fields.reason_for_looking}`);
    if (fields.target_base_comp || fields.target_total_comp)
      noteLines.push(`Target comp: ${fields.target_base_comp || ""} base / ${fields.target_total_comp || ""} total`);
    if (fields.current_base_comp || fields.current_total_comp)
      noteLines.push(`Current comp: ${fields.current_base_comp || ""} base / ${fields.current_total_comp || ""} total`);
    if (fields.target_locations) noteLines.push(`Target locations: ${fields.target_locations}`);
    if (fields.target_roles) noteLines.push(`Target roles: ${fields.target_roles}`);
    if (fields.notice_period) noteLines.push(`Notice period: ${fields.notice_period}`);
    if (fields.availability_notes) noteLines.push(`Availability: ${fields.availability_notes}`);
    if (fields.skills_mentioned?.length)
      noteLines.push(`Skills: ${fields.skills_mentioned.join(", ")}`);

    if (noteLines.length > 0) {
      const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const note = `\n--- ${channel} intel (${dateStr}) ---\n${noteLines.join("\n")}`;

      // Fetch current notes and append
      const { data: entity } = await supabase
        .from("people")
        .select("back_of_resume_notes")
        .eq("id", entityId)
        .single();

      const existing = entity?.back_of_resume_notes || "";
      await supabase
        .from("people")
        .update({ back_of_resume_notes: existing + note } as any)
        .eq("id", entityId);

      logger.info("Appended intel to back_of_resume_notes", {
        entityId,
        extractedFields: noteLines.length,
      });
    }
  }

  // Pipeline automation based on sentiment
  if (entityType === "candidate") {
    const negativeSentiments = ["negative", "not_interested", "do_not_contact"];
    const positiveSentiments = ["interested", "positive"];

    if (negativeSentiments.includes(intel.sentiment)) {
      await supabase
        .from("send_outs")
        .update({
          stage: "rejected",
          rejected_by: "candidate",
          rejection_reason: intel.sentiment.replace(/_/g, " "),
          feedback: intel.summary,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("candidate_id", entityId)
        .not("stage", "in", '("rejected","placed","withdrawn")');
    }

    if (positiveSentiments.includes(intel.sentiment)) {
      await supabase
        .from("send_outs")
        .update({
          stage: "pitch",
          updated_at: new Date().toISOString(),
        } as any)
        .eq("candidate_id", entityId)
        .in("stage", ["new", "reached_out"]);
    }
  }
}
