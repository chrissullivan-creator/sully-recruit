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
import { logger } from "@trigger.dev/sdk/v3";
import { getAnthropicKey, getOpenAIKey } from "./supabase";
import { callAIWithFallback } from "../../lib/ai-fallback";
import { notifyError } from "./alerting";

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
    const [apiKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
    const { text, via } = await callAIWithFallback({
      anthropicKey: apiKey,
      openaiKey: openaiKey || undefined,
      systemPrompt: EXTRACTION_PROMPT,
      userContent: fullText.slice(0, 3000),
      model: "claude-haiku-4-5-20251001",
      maxTokens: 500,
      jsonOutput: true,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("Intel extraction returned non-JSON", {
        via, snippet: text.slice(0, 200),
      });
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]) as ExtractedIntel;
    } catch (parseErr: any) {
      logger.warn("Intel extraction JSON parse failed", {
        via, error: parseErr.message, snippet: jsonMatch[0].slice(0, 200),
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

  // Store sentiment in reply_sentiment table
  await supabase.from("reply_sentiment").insert({
    [entityColumn]: entityId,
    enrollment_id: enrollmentId || null,
    channel,
    sentiment: intel.sentiment,
    summary: intel.summary,
    analyzed_at: new Date().toISOString(),
  } as any);

  // Update sentiment on enrollment if provided
  if (enrollmentId) {
    await supabase
      .from("sequence_enrollments")
      .update({
        reply_sentiment: intel.sentiment,
        reply_sentiment_note: intel.summary,
      } as any)
      .eq("id", enrollmentId);
  }

  // Update sentiment on entity
  await supabase
    .from(table)
    .update({
      last_sequence_sentiment: intel.sentiment,
      last_sequence_sentiment_note: intel.summary,
    } as any)
    .eq("id", entityId);

  // Build update object with only non-null extracted fields
  const updates: Record<string, any> = {};

  if (entityType === "candidate") {
    if (fields.current_title) updates.current_title = fields.current_title;
    if (fields.current_company) updates.current_company = fields.current_company;
    if (fields.reason_for_looking) updates.reason_for_leaving = fields.reason_for_looking;
    if (fields.current_base_comp) updates.current_base_comp = fields.current_base_comp;
    if (fields.current_total_comp) updates.current_total_comp = fields.current_total_comp;
    if (fields.target_base_comp) updates.target_base_comp = fields.target_base_comp;
    if (fields.target_total_comp) updates.target_total_comp = fields.target_total_comp;
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
