import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getOpenRouterKey,
} from "../../../../src/server-lib/supabase.js";
import { callAIWithFallback } from "../../../../src/lib/ai-fallback.js";

interface Payload {
  callLogId: string;
}

const SYSTEM_PROMPT = `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from these notes a recruiter typed after a call. Finance-aware, no fluff, but be thorough — recruiters use this as their working brief, so the more signal you pull, the better.

Return ONLY valid JSON in this exact shape:
{"summary":"...","action_items":"...","reason_for_leaving":null,"current_base":null,"current_bonus":null,"current_total":null,"target_base":null,"target_bonus":null,"target_total":null,"comp_notes":null,"current_title":null,"current_company":null,"personal_email":null,"skills":null,"notes":null,"fun_facts":null,"visa_status":null,"work_authorization":null,"relocation_preference":null,"target_locations":null,"target_roles":null,"where_interviewed":null,"where_submitted":null,"notice_period":null,"desired_start":null,"urgency":null,"decision_timeline":null,"deal_breakers":null,"counter_offer_history":null,"manager_relationship":null,"looking_to_do_next":null,"dislikes_current_role":null,"relo_details":null,"job_move_explanations":null}

Field rules:
- summary: 5–10 sentences. Cover who they are, current situation, what they're looking for, comp + timeline signals, fit concerns, red flags, and any commitments. Strategic, not a notes dump.
- action_items: bulleted list ("- " prefix) of concrete next steps. "- None" when there are none.
- notes: detailed back-of-resume intel — products, business lines, divisions, function, motivations, verbatim quotes, soft signals, personality observations, blockers. Different from summary. Null when there's nothing to add beyond what's in the typed notes.
- reason_for_leaving: short phrase. Null if not discussed.
- current_title / current_company: short strings. Null if not stated.
- current_base, current_bonus, current_total, target_base, target_bonus, target_total: single integer (annual USD, no commas, no symbol, no strings). Range → midpoint. Vague signal → best estimate. Null if not discussed.
- comp_notes: anything compensation-related that doesn't fit the numeric fields — RSU vesting, deferred comp, sign-on, retention, carry, equity %, bonus targets. Null if no nuance.
- personal_email: their non-work email if explicitly shared. Null if not mentioned.
- skills: short array of specific skills, products, technologies, certifications mentioned. Empty array if none.
- fun_facts: hobbies, interests, family, connection points. Null if nothing personal came up.
- visa_status: long-form sponsorship signal. "US Citizen", "Green Card", "H-1B (sponsorship needed)", "F-1/OPT (transfer required)", etc. Null if not discussed.
- work_authorization: short status string — "Citizen", "GC", "H-1B", "F-1/OPT", "TN". Distinct from visa_status; this is the form-field summary. Null if not discussed.
- relocation_preference: short string — "Open", "No", "NYC only", "Open to East Coast", "Open with relo package". Null if not discussed.
- target_locations: short comma-separated list of cities or regions. Null if not discussed.
- target_roles: short comma-separated list of role types. Null if not discussed.
- where_interviewed / where_submitted: firms they're in process at / have been submitted to. Null if not discussed.
- notice_period: "2 weeks", "30 days", "immediately". Null if not discussed.
- desired_start: target start window separate from notice — "Sept 1", "after bonus payout", "Q4". Null if not discussed.
- urgency: how actively they're moving — "actively interviewing", "exploring quietly", "passive — only for the right seat". Null if no signal.
- decision_timeline: how long they take to decide, or any deadline. "2 weeks once an offer lands", "no rush". Null if not discussed.
- deal_breakers: hard requirements — "no role under VP", "no IB hours", "no relocation". Null if none stated.
- counter_offer_history: whether they've been counter-offered, what they did with it, or whether current firm is likely to counter. Null if not discussed.
- manager_relationship: relationship with current manager — "strained", "great mentor", "neutral". Important sourcing signal. Null if not discussed.
- looking_to_do_next: concrete career direction (function / firm-type / level). 1–2 sentences. Null if not discussed.
- dislikes_current_role: specific complaints (manager, comp, scope, hours, growth). Verbatim where useful. Null if not discussed.
- relo_details: willingness, family situation, blocked cities, timing — the detail behind relocation_preference. Null if not discussed.
- job_move_explanations: why they made each prior job change (esp. short stints / gaps / lateral moves). Null if not discussed.

Recruiter notes are a higher signal-to-noise input than a raw transcript — when the recruiter wrote it, treat it as fact, not a thing to second-guess.`;

/**
 * Run Joe intel extraction on a manually-logged call's recruiter notes.
 * Mirrors process-call-deepgram for Deepgram-transcribed RC calls but
 * the input is the recruiter's typed notes rather than ASR transcript.
 *
 * Ported from `src/trigger/extract-manual-call-intel.ts`. The
 * Trigger.dev wrapper at the same source path now forwards via
 * `messages/extract-call-intel.requested`.
 */
export const extractManualCallIntel = inngest.createFunction(
  { id: "extract-manual-call-intel", name: "Extract intel from manual call notes (Inngest)", retries: 2 },
  { event: "messages/extract-call-intel.requested" },
  async ({ event, logger }) => {
    const { callLogId } = event.data as Payload;
    const supabase = getSupabaseAdmin();

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
      .select("full_name, call_structured_notes, personal_email, skills")
      .eq("id", candidateId)
      .maybeSingle();
    const entityName = candidate?.full_name || "candidate";
    const duration = cl.duration_seconds
      ? `${Math.floor(cl.duration_seconds / 60)}m ${cl.duration_seconds % 60}s`
      : "unspecified-length";

    const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getGeminiKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
    ]);
    if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
      logger.warn("No AI keys configured — skipping extraction");
      return { skipped: true, reason: "no_ai_keys" };
    }

    let intel: Record<string, any>;
    try {
      const { text } = await callAIWithFallback({
        anthropicKey: anthropicKey || undefined,
        openaiKey: openaiKey || undefined,
        geminiKey: geminiKey || undefined,
        openRouterKey: openRouterKey || undefined,
        systemPrompt: SYSTEM_PROMPT,
        userContent: `Call with ${entityName} (${duration}).\n\nRecruiter notes:\n${notes.slice(0, 30_000)}`,
        model: "claude-sonnet-4-6",
        maxTokens: 2000,
        jsonOutput: true,
      });
      intel = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (err: any) {
      logger.warn("Joe extraction failed on manual notes", { error: err?.message });
      return { error: err?.message ?? "extraction_failed" };
    }

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
    const ct = toInt(intel.current_total); if (ct !== null) updates.current_total_comp = ct;
    const tb = toInt(intel.target_base); if (tb !== null) updates.target_base_comp = tb;
    const tbn = toInt(intel.target_bonus); if (tbn !== null) updates.target_bonus_comp = tbn;
    const tt = toInt(intel.target_total); if (tt !== null) updates.target_total_comp = tt;
    if (intel.comp_notes) updates.comp_notes = intel.comp_notes;
    if (intel.current_title) updates.current_title = intel.current_title;
    if (intel.current_company) updates.current_company = intel.current_company;
    // personal_email: only fill when blank — don't overwrite a curated value.
    if (intel.personal_email && typeof intel.personal_email === "string" && intel.personal_email.includes("@")) {
      if (!(candidate as any)?.personal_email) updates.personal_email = intel.personal_email.trim().toLowerCase();
    }
    // skills: merge with existing rather than overwrite (case-insensitive dedupe).
    if (Array.isArray(intel.skills) && intel.skills.length) {
      const fresh = intel.skills.filter((s: any): s is string => typeof s === "string" && s.trim().length > 0).map((s: string) => s.trim());
      if (fresh.length) {
        const prior: string[] = Array.isArray((candidate as any)?.skills) ? (candidate as any).skills : [];
        const seen = new Set(prior.map((s) => s.toLowerCase()));
        for (const s of fresh) if (!seen.has(s.toLowerCase())) { prior.push(s); seen.add(s.toLowerCase()); }
        updates.skills = prior.slice(0, 50);
      }
    }
    if (intel.notes) updates.back_of_resume_notes = intel.notes;
    if (intel.fun_facts) updates.fun_facts = intel.fun_facts;
    if (intel.visa_status) updates.visa_status = intel.visa_status;
    if (intel.work_authorization) updates.work_authorization = intel.work_authorization;
    if (intel.relocation_preference) updates.relocation_preference = intel.relocation_preference;
    if (intel.target_locations) updates.target_locations = intel.target_locations;
    if (intel.target_roles) updates.target_roles = intel.target_roles;
    if (intel.where_interviewed) updates.where_interviewed = intel.where_interviewed;
    if (intel.where_submitted) updates.where_submitted = intel.where_submitted;
    if (intel.notice_period) updates.notice_period = intel.notice_period;

    const structuredKeys = [
      "looking_to_do_next",
      "dislikes_current_role",
      "relo_details",
      "job_move_explanations",
      "desired_start",
      "urgency",
      "decision_timeline",
      "deal_breakers",
      "counter_offer_history",
      "manager_relationship",
    ] as const;
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

    // Refresh the Joe Says brief now that the typed notes enriched the
    // candidate. Best-effort — never fail the extraction on an event send.
    try {
      await inngest.send({
        name: "ai/joe-says.requested",
        data: { entityId: candidateId, entityType: "candidate" },
      });
    } catch (err: any) {
      logger.warn("joe-says fire after manual call intel failed", { error: err?.message, candidateId });
    }

    logger.info("Manual call intel extracted", { candidateId, callLogId });
    return {
      success: true,
      candidateId,
      fieldsUpdated: Object.keys(updates).filter((k) => k !== "updated_at"),
    };
  },
);
