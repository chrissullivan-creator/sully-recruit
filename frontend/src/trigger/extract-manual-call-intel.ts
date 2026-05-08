import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getOpenAIKey } from "./lib/supabase";
import { callAIWithFallback } from "../lib/ai-fallback";

/**
 * Run Joe intel extraction on a manually-logged call's recruiter notes.
 *
 * Mirrors what process-call-deepgram does for Deepgram-transcribed
 * RingCentral calls — but the input is the recruiter's typed notes
 * rather than an ASR transcript. Same JSON shape so the same
 * downstream fields get populated on the candidate.
 *
 * Triggered fire-and-forget by /api/trigger-extract-call-intel after
 * the user logs a call from the Calls page (or links an existing
 * untagged call to a candidate). No-ops when:
 *   - the call has no candidate_id / linked_entity_id of type candidate
 *   - notes are too short (< 80 chars) to produce meaningful intel
 */
interface Payload {
  callLogId: string;
}

const SYSTEM_PROMPT = `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from these notes a recruiter typed after a call. Finance-aware, no fluff, but be thorough enough to be useful.

Return ONLY valid JSON in this exact shape:
{"summary":"...","action_items":"...","reason_for_leaving":null,"current_base":null,"current_bonus":null,"target_base":null,"target_bonus":null,"current_title":null,"current_company":null,"notes":null,"fun_facts":null,"visa_status":null,"where_interviewed":null,"where_submitted":null,"notice_period":null,"looking_to_do_next":null,"dislikes_current_role":null,"relo_details":null,"job_move_explanations":null}

Field rules:
- summary: 4–8 sentences. Cover who they are, current situation, what they're looking for, and any notable signals (urgency, fit concerns, red flags). Strategic, not a notes dump.
- action_items: bulleted list ("- " prefix) of concrete next steps. "- None" when there are none.
- notes: detailed back-of-resume intel — products, business lines, divisions, function, motivations, verbatim quotes worth remembering, soft signals, personality observations, blockers. Different from summary. Null when there's nothing to add beyond what's already in the typed notes.
- reason_for_leaving: short phrase. Null if not discussed.
- current_title / current_company: short strings. Null if not stated.
- current_base, current_bonus, target_base, target_bonus: single integer (annual USD, no commas, no symbol, no strings). Range → midpoint. Vague signal ("comfortable in the 200s") → best estimate. Null if not discussed at all.
- fun_facts: hobbies, interests, family, connection points. Null if nothing personal came up.
- visa_status: "US Citizen", "H-1B", "Green Card", "F-1/OPT", etc. Null if not discussed.
- where_interviewed / where_submitted: firms they're in process at / have been submitted to. Null if not discussed.
- notice_period: "2 weeks", "30 days", "immediately". Null if not discussed.
- looking_to_do_next: concrete career direction (function / firm-type / level). 1–2 sentences. Null if not discussed.
- dislikes_current_role: specific complaints (manager, comp, scope, hours, growth). Verbatim where useful. Null if not discussed.
- relo_details: willingness, family situation, blocked cities, timing. Null if not discussed.
- job_move_explanations: why they made each prior job change (especially short stints / gaps / lateral moves). Null if not discussed.

Recruiter notes are a higher signal-to-noise input than a raw transcript — when the recruiter wrote it, treat it as fact, not a thing to second-guess.`;

export const extractManualCallIntel = task({
  id: "extract-manual-call-intel",
  retry: { maxAttempts: 2 },
  run: async ({ callLogId }: Payload) => {
    const supabase = getSupabaseAdmin();

    // Supabase's generated types treat call_logs polymorphically and
    // collapse the response to a SelectQueryError union; the row shape
    // is intact at runtime so we cast through `any`.
    const { data: clRaw, error: clErr } = await supabase
      .from("call_logs")
      .select(
        "id, notes, duration_seconds, candidate_id, contact_id, " +
        "linked_entity_id, linked_entity_type",
      )
      .eq("id", callLogId)
      .maybeSingle();
    const cl = clRaw as any;
    if (clErr || !cl) {
      logger.warn("call_logs row not found", { callLogId, error: clErr?.message });
      return { skipped: true, reason: "call_not_found" };
    }

    const candidateId: string | null =
      cl.candidate_id ??
      (cl.linked_entity_type === "candidate" ? cl.linked_entity_id : null);
    if (!candidateId) {
      return { skipped: true, reason: "not_a_candidate" };
    }

    const notes: string = (cl.notes ?? "").trim();
    if (notes.length < 80) {
      return { skipped: true, reason: "notes_too_short" };
    }

    const { data: candidate } = await supabase
      .from("people")
      .select("full_name, call_structured_notes")
      .eq("id", candidateId)
      .maybeSingle();
    const entityName = candidate?.full_name || "candidate";
    const duration = cl.duration_seconds
      ? `${Math.floor(cl.duration_seconds / 60)}m ${cl.duration_seconds % 60}s`
      : "unspecified-length";

    const [anthropicKey, openaiKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
    ]);
    if (!anthropicKey && !openaiKey) {
      logger.warn("No AI keys configured — skipping extraction");
      return { skipped: true, reason: "no_ai_keys" };
    }

    let intel: Record<string, any>;
    try {
      const { text } = await callAIWithFallback({
        anthropicKey: anthropicKey || undefined,
        openaiKey: openaiKey || undefined,
        systemPrompt: SYSTEM_PROMPT,
        userContent: `Call with ${entityName} (${duration}).\n\nRecruiter notes:\n${notes.slice(0, 30_000)}`,
        model: "claude-sonnet-4-20250514",
        maxTokens: 2000,
        jsonOutput: true,
      });
      intel = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (err: any) {
      logger.warn("Joe extraction failed on manual notes", { error: err?.message });
      return { error: err?.message ?? "extraction_failed" };
    }

    // Coerce comp fields to integers, same as the deepgram path.
    const toInt = (v: any): number | null => {
      if (v == null) return null;
      if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
      if (typeof v === "string") {
        const nums = v.match(/\d[\d,]*/g);
        if (!nums?.length) return null;
        const parsed = nums.map((n) => parseInt(n.replace(/,/g, ""), 10)).filter(Number.isFinite);
        if (!parsed.length) return null;
        const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
        return Math.round(avg);
      }
      return null;
    };

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
    const cb = toInt(intel.current_base); if (cb !== null) updates.current_base_comp = cb;
    const cbn = toInt(intel.current_bonus); if (cbn !== null) updates.current_bonus_comp = cbn;
    const tb = toInt(intel.target_base); if (tb !== null) updates.target_base_comp = tb;
    const tbn = toInt(intel.target_bonus); if (tbn !== null) updates.target_bonus_comp = tbn;
    if (intel.current_title) updates.current_title = intel.current_title;
    if (intel.current_company) updates.current_company = intel.current_company;
    if (intel.notes) updates.back_of_resume_notes = intel.notes;
    if (intel.fun_facts) updates.fun_facts = intel.fun_facts;
    if (intel.visa_status) updates.visa_status = intel.visa_status;
    if (intel.where_interviewed) updates.where_interviewed = intel.where_interviewed;
    if (intel.where_submitted) updates.where_submitted = intel.where_submitted;
    if (intel.notice_period) updates.notice_period = intel.notice_period;

    // Park qualitative fields on call_structured_notes so Joe Says picks
    // them up. Merge with any prior structured payload — the deepgram
    // path uses the same column for the same fields.
    const structuredKeys = ["looking_to_do_next", "dislikes_current_role", "relo_details", "job_move_explanations"] as const;
    const structuredAdds: Record<string, string> = {};
    for (const k of structuredKeys) {
      const v = (intel as any)[k];
      if (v && typeof v === "string" && v.trim()) structuredAdds[k] = v.trim();
    }
    if (Object.keys(structuredAdds).length) {
      const prior = (candidate?.call_structured_notes as Record<string, any> | null) ?? {};
      updates.call_structured_notes = {
        ...prior,
        ...structuredAdds,
        last_call_at: updates.updated_at,
      };
    }

    const { error: updErr } = await supabase
      .from("people")
      .update(updates)
      .eq("id", candidateId);
    if (updErr) {
      logger.error("Failed to apply intel to candidate", { candidateId, error: updErr.message });
      return { error: updErr.message };
    }

    // Mirror the deepgram path: write an ai_call_notes row so the
    // call detail view shows the AI summary + action items alongside
    // the raw notes.
    await supabase.from("ai_call_notes").upsert({
      candidate_id: candidateId,
      phone_number: null,
      source: "manual_notes",
      call_direction: "outbound",
      call_duration_seconds: cl.duration_seconds ?? null,
      call_duration_formatted: duration,
      ai_summary: intel.summary ?? null,
      ai_action_items: intel.action_items ?? null,
      extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
      extracted_current_base: toInt(intel.current_base),
      extracted_current_bonus: toInt(intel.current_bonus),
      extracted_target_base: toInt(intel.target_base),
      extracted_target_bonus: toInt(intel.target_bonus),
      extracted_notes: intel.notes ?? null,
      call_log_id: cl.id,
      created_at: new Date().toISOString(),
    } as any, { onConflict: "call_log_id", ignoreDuplicates: false });

    logger.info("Manual call intel extracted", { candidateId, callLogId });
    return {
      success: true,
      candidateId,
      fieldsUpdated: Object.keys(updates).filter((k) => k !== "updated_at"),
    };
  },
});
