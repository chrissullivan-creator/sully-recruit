import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getOpenRouterKey,
} from "../../../../src/trigger/lib/supabase.js";
import { callAIWithFallback } from "../../../../src/lib/ai-fallback.js";

/**
 * Backfill candidate fields from STORED call transcripts using the
 * current (#262) recap prompt. This is the cheap path for going back
 * over old calls: ai_call_notes already has the transcript, so we
 * skip Deepgram and only pay for Claude tokens. Each successful
 * re-extraction bumps ai_call_notes.reextraction_version so the
 * sweeper doesn't reprocess the same row repeatedly.
 *
 * Cron every 15 min, batch 15. Also event-triggerable via
 * `ops/reextract-call-intel.requested` for one-shot recovery.
 */
const CURRENT_REEXTRACTION_VERSION = 1;

function makePrompt(entityName: string, duration: string): string {
  return `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from this ${duration} call with ${entityName}. Finance-aware, no fluff, but be thorough — recruiters use this as their working brief, so the more signal you pull, the better.

Return ONLY valid JSON in this exact shape:
{"summary":"...","action_items":"...","reason_for_leaving":null,"current_base":null,"current_bonus":null,"current_total":null,"target_base":null,"target_bonus":null,"target_total":null,"comp_notes":null,"current_title":null,"current_company":null,"personal_email":null,"skills":null,"notes":null,"fun_facts":null,"visa_status":null,"work_authorization":null,"relocation_preference":null,"target_locations":null,"target_roles":null,"where_interviewed":null,"where_submitted":null,"notice_period":null,"desired_start":null,"urgency":null,"decision_timeline":null,"deal_breakers":null,"counter_offer_history":null,"manager_relationship":null,"looking_to_do_next":null,"dislikes_current_role":null,"relo_details":null,"job_move_explanations":null}

Field rules:
- summary: 5–10 sentences. Cover who they are, current situation, what they're looking for, comp & timeline signals, fit concerns, red flags, and any commitments made.
- action_items: bulleted list with "- " prefix. "- None" when there are none.
- notes: detailed back-of-resume intel — products, business lines, divisions, function, motivations, verbatim quotes, soft signals, blockers.
- current_base, current_bonus, current_total, target_base, target_bonus, target_total: single integer (annual USD, no commas/symbols/strings/ranges). Range → midpoint. Vague → best estimate.
- comp_notes: anything compensation-related that doesn't fit the numeric fields — RSU vesting, deferred, sign-on, retention, carry, equity %, bonus targets.
- personal_email: their non-work email if explicitly shared.
- skills: short array of specific skills, products, technologies, certifications mentioned. Empty array if none.
- visa_status / work_authorization: long-form vs short status string for sponsorship signal.
- relocation_preference: "Open", "No", "NYC only", etc.
- target_locations / target_roles: comma-separated lists.
- where_interviewed / where_submitted: firms they're in process at / submitted to.
- notice_period: "2 weeks", "30 days", etc.
- desired_start: target start window — "Sept 1", "after bonus payout", "Q4".
- urgency: "actively interviewing", "exploring quietly", "passive — only for the right seat".
- decision_timeline: "2 weeks once an offer lands", "no rush".
- deal_breakers: hard requirements — "no role under VP", "no IB hours".
- counter_offer_history: whether they've been counter-offered before / if current firm will counter.
- manager_relationship: "strained", "great mentor", "neutral".
- looking_to_do_next / dislikes_current_role / relo_details / job_move_explanations / fun_facts: prose where useful, null otherwise.

Null means "not discussed", not "make something up". Be ruthless about that.`;
}

function toInt(v: any): number | null {
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
}

async function applyIntelToCandidate(supabase: any, entityId: string, intel: any, logger: any): Promise<void> {
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

  // personal_email — only fill when blank (don't clobber curated values)
  if (intel.personal_email && typeof intel.personal_email === "string" && intel.personal_email.includes("@")) {
    const { data: existing } = await supabase.from("people").select("personal_email").eq("id", entityId).maybeSingle();
    if (!existing?.personal_email) updates.personal_email = intel.personal_email.trim().toLowerCase();
  }

  // skills — merge with existing (case-insensitive dedupe)
  if (Array.isArray(intel.skills) && intel.skills.length) {
    const fresh = intel.skills.filter((s: any): s is string => typeof s === "string" && s.trim().length > 0).map((s: string) => s.trim());
    if (fresh.length) {
      const { data: existing } = await supabase.from("people").select("skills").eq("id", entityId).maybeSingle();
      const prior: string[] = Array.isArray(existing?.skills) ? existing.skills : [];
      const seen = new Set(prior.map((s) => s.toLowerCase()));
      for (const s of fresh) if (!seen.has(s.toLowerCase())) { prior.push(s); seen.add(s.toLowerCase()); }
      updates.skills = prior.slice(0, 50);
    }
  }

  // structured notes (JSON column) — merge keys
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
    const { data: existing } = await supabase.from("people").select("call_structured_notes").eq("id", entityId).maybeSingle();
    const prior = (existing?.call_structured_notes as Record<string, any> | null) ?? {};
    updates.call_structured_notes = { ...prior, ...structuredAdds, last_reextracted_at: updates.updated_at };
  }

  const { error: updErr } = await supabase.from("people").update(updates).eq("id", entityId);
  if (updErr) {
    logger.warn("Candidate update failed during re-extraction", { entityId, error: updErr.message });
  }
}

async function runSweep(logger: any, batch = 15) {
  const supabase = getSupabaseAdmin();

  const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
    getAnthropicKey().catch(() => ""),
    getOpenAIKey().catch(() => ""),
    getGeminiKey().catch(() => ""),
    getOpenRouterKey().catch(() => ""),
  ]);
  if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
    logger.warn("No AI keys configured — cannot re-extract");
    return { processed: 0, reason: "no_ai_keys" };
  }

  // Pull a batch of unprocessed notes that still have a transcript.
  // Order by call_log started_at descending so recent calls get the
  // refreshed extraction first.
  const { data: rows, error } = await supabase
    .from("ai_call_notes")
    .select("id, candidate_id, contact_id, transcript, call_duration_seconds, call_duration_formatted, external_call_id, call_log_id")
    .lt("reextraction_version", CURRENT_REEXTRACTION_VERSION)
    .not("transcript", "is", null)
    .order("created_at", { ascending: false })
    .limit(batch * 3);

  if (error) {
    logger.error("Failed to query ai_call_notes", { error: error.message });
    return { processed: 0, error: error.message };
  }
  const candidates = (rows ?? []).filter((r: any) => (r.transcript?.length ?? 0) > 200).slice(0, batch);
  if (candidates.length === 0) {
    logger.info("No re-extractable transcripts in queue");
    return { processed: 0 };
  }

  let processed = 0;
  let updated = 0;
  for (const note of candidates as any[]) {
    const entityId = note.candidate_id || note.contact_id;
    if (!entityId) {
      // No linked entity → just mark version-bumped so we don't keep
      // re-processing it forever.
      await supabase.from("ai_call_notes").update({ reextraction_version: CURRENT_REEXTRACTION_VERSION } as any).eq("id", note.id);
      processed++;
      continue;
    }
    const { data: person } = await supabase.from("people").select("full_name").eq("id", entityId).maybeSingle();
    const entityName = person?.full_name || "candidate";
    const duration = note.call_duration_formatted || (note.call_duration_seconds
      ? `${Math.floor(note.call_duration_seconds / 60)}m ${note.call_duration_seconds % 60}s`
      : "unspecified-length");

    let intel: any;
    try {
      const { text } = await callAIWithFallback({
        anthropicKey: anthropicKey || undefined,
        openaiKey: openaiKey || undefined,
        geminiKey: geminiKey || undefined,
        openRouterKey: openRouterKey || undefined,
        systemPrompt: makePrompt(entityName, duration),
        userContent: `Transcript:\n${(note.transcript as string).slice(0, 30000)}`,
        model: "claude-sonnet-4-6",
        maxTokens: 2000,
        jsonOutput: true,
      });
      intel = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (err: any) {
      logger.warn("Re-extraction failed", { noteId: note.id, error: err?.message });
      // Don't bump version on failure — we'll retry next cron tick.
      processed++;
      continue;
    }

    // Only apply candidate updates for candidate-side records (contacts
    // have a different shape and aren't the primary use case here).
    if (note.candidate_id) {
      await applyIntelToCandidate(supabase, note.candidate_id, intel, logger);
    }

    // Refresh ai_call_notes with the new extracted values + bump version.
    await supabase
      .from("ai_call_notes")
      .update({
        ai_summary: intel.summary ?? null,
        ai_action_items: intel.action_items ?? null,
        extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
        extracted_current_base: toInt(intel.current_base),
        extracted_current_bonus: toInt(intel.current_bonus),
        extracted_target_base: toInt(intel.target_base),
        extracted_target_bonus: toInt(intel.target_bonus),
        extracted_notes: intel.notes ?? null,
        reextraction_version: CURRENT_REEXTRACTION_VERSION,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", note.id);

    processed++;
    updated++;
  }

  logger.info("Re-extraction sweep complete", { processed, updated, batch_size: candidates.length });
  return { processed, updated };
}

export const reextractCallIntelCron = inngest.createFunction(
  {
    id: "reextract-call-intel-cron",
    name: "Re-extract candidate intel from stored transcripts (Inngest cron)",
  },
  { cron: "11-59/15 * * * *" },
  async ({ logger }) => runSweep(logger, 15),
);

export const reextractCallIntel = inngest.createFunction(
  {
    id: "reextract-call-intel",
    name: "Re-extract candidate intel from stored transcripts (event-triggered)",
  },
  { event: "ops/reextract-call-intel.requested" },
  async ({ event, logger }) => {
    const batch = Number((event.data as any)?.batch) || 30;
    return runSweep(logger, batch);
  },
);
