import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function fmt(s: number) { return `${Math.floor(s / 60)}m ${s % 60}s`; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const { call_log_id, notes } = body;

    if (!call_log_id) return respond({ error: "call_log_id required" }, 400);
    if (!notes?.trim()) return respond({ error: "notes required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: call, error: callErr } = await supabase
      .from("call_logs")
      .select("id, external_call_id, candidate_id, contact_id, duration_seconds, linked_entity_name, candidates!left(full_name, current_title, current_company)")
      .eq("id", call_log_id)
      .single();

    if (callErr || !call) return respond({ error: "Call not found" }, 404);

    const candidateName = (call.candidates as any)?.full_name ?? call.linked_entity_name ?? "candidate";
    const duration = call.duration_seconds ? fmt(call.duration_seconds) : "unknown duration";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        system: `You are Joe — the AI backbone of Sully Recruit, a Wall Street recruiting firm specializing in hedge funds, investment banks, trading houses, fintech, and asset managers.

You are reading a ${duration} recruiter call with ${candidateName}. Extract EVERYTHING useful. Be terse, specific, and finance-aware. No fluff.

Return ONLY valid JSON matching this exact schema. Use null for anything not mentioned:
{
  "summary": "3-5 sentence punchy summary: who they are, why they're looking, what they want, what's notable, what's next",
  "action_items": "Bulleted next steps starting with -, one per line",

  "candidate_profile": {
    "current_title": "exact current title",
    "current_company": "exact current employer",
    "current_team_size": "number of people they manage or work with directly",
    "tenure_at_current": "how long at current role",
    "total_yoe": "total years of experience mentioned",
    "education": "degree/school if mentioned",
    "location_current": "where they are now",
    "location_target": "where they want to be",
    "willing_to_relocate": true/false/null
  },

  "compensation": {
    "current_base": null or number,
    "current_bonus": null or number,
    "current_bonus_pct": null or number (as percentage e.g. 51),
    "current_total": null or number,
    "target_base": null or number,
    "target_total": null or number,
    "comp_notes": "any nuance: unvested equity, deferred comp, signing bonus needed, cost-of-living delta, etc."
  },

  "job_search": {
    "reason_for_leaving": "specific reason, not generic",
    "urgency": "passive/active/urgent",
    "timeline": "how soon they want to move",
    "notice_period": "weeks or months",
    "non_compete": true/false/null,
    "non_compete_details": "duration and scope if mentioned",
    "bonus_situation": "received/pending/forfeitable — timing matters",
    "competing_processes": "other firms they're interviewing at, stage, role type",
    "target_role_types": "what kinds of roles they want",
    "target_firms": "specific firms or firm types they want",
    "deal_breakers": "what they won't do"
  },

  "skills_and_experience": {
    "asset_classes": ["list of asset classes: equities, fixed income, FX, derivatives, credit, rates, etc."],
    "instruments": ["specific instruments: TRS, CDS, SOFR, repo, TBA, munis, CLOs, etc."],
    "functions": ["ops, trading, risk, tech, compliance, PM, quant, etc."],
    "office_function": "front/middle/back",
    "systems": ["specific systems/platforms: Aladdin, Advent, SimCorp, Bloomberg, Murex, Calypso, etc."],
    "notable_achievements": ["specific quantifiable wins or major projects"]
  },

  "logistics": {
    "work_preference": "in-office/hybrid/remote preference",
    "days_in_office_preferred": null or number,
    "travel_ok": true/false/null,
    "visa_status": "citizen/GC/H1B/etc if mentioned"
  },

  "fit_assessment": {
    "red_flags": ["anything concerning: job hopping, vague answers, unrealistic comp, difficult personality"],
    "green_flags": ["strong positives: pedigree, specific skills, urgency, flexible on comp"],
    "overall_vibe": "hot/warm/cold/voicemail/scheduling-only",
    "recruiter_notes": "anything the recruiter said about the candidate, the role, or next steps"
  },

  "roles_discussed": [
    {
      "firm": "firm name",
      "title": "role title",
      "comp_range": "range discussed",
      "status": "submitted/interviewing/offer/rejected/pending",
      "notes": "any context"
    }
  ]
}`,
        messages: [{ role: "user", content: `Call transcript/notes:\n\n${notes}` }],
      }),
    });

    if (!aiRes.ok) throw new Error(`Claude ${aiRes.status}`);
    const aiData = await aiRes.json();
    const intel = JSON.parse(
      (aiData.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim()
    );

    const now = new Date().toISOString();

    // Flatten for legacy columns + store full structured notes
    const comp = intel.compensation ?? {};
    const profile = intel.candidate_profile ?? {};
    const search = intel.job_search ?? {};
    const skills = intel.skills_and_experience ?? {};

    await supabase.from("call_logs").update({
      notes,
      summary: intel.summary,
      updated_at: now,
    }).eq("id", call_log_id);

    await supabase.from("ai_call_notes").upsert({
      candidate_id: call.candidate_id ?? null,
      contact_id: call.contact_id ?? null,
      source: "manual_notes",
      call_direction: "outbound",
      call_duration_seconds: call.duration_seconds ?? null,
      call_duration_formatted: call.duration_seconds ? fmt(call.duration_seconds) : null,
      transcript: notes,
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: search.reason_for_leaving ?? null,
      extracted_current_base: comp.current_base ?? null,
      extracted_current_bonus: comp.current_bonus ?? null,
      extracted_target_base: comp.target_base ?? null,
      extracted_target_bonus: null,
      extracted_notes: `${search.competing_processes ? `Competing: ${search.competing_processes}. ` : ""}${search.bonus_situation ? `Bonus: ${search.bonus_situation}. ` : ""}${search.non_compete ? `Non-compete: ${search.non_compete_details ?? "yes"}. ` : ""}${(intel.fit_assessment?.red_flags ?? []).length ? `Red flags: ${intel.fit_assessment.red_flags.join("; ")}` : ""}`.trim() || null,
      processing_status: "completed",
      external_call_id: call.external_call_id ?? null,
      structured_notes: intel,
      created_at: now,
    }, { onConflict: "external_call_id", ignoreDuplicates: false });

    if (call.candidate_id) {
      const updates: Record<string, any> = {
        updated_at: now,
        status: "back_of_resume",
        call_structured_notes: intel,
      };
      if (search.reason_for_leaving) updates.reason_for_leaving = search.reason_for_leaving;
      if (comp.current_base) updates.current_base_comp = comp.current_base;
      if (comp.current_bonus) updates.current_bonus_comp = comp.current_bonus;
      if (comp.target_base) updates.target_base_comp = comp.target_base;
      if (comp.target_total) updates.target_total_comp = comp.target_total;
      if (profile.current_title) updates.current_title = profile.current_title;
      if (profile.current_company) updates.current_company = profile.current_company;
      const notesText = [
        intel.summary,
        search.competing_processes ? `\nCompeting: ${search.competing_processes}` : "",
        (skills.notable_achievements ?? []).length ? `\nAchievements: ${skills.notable_achievements.join("; ")}` : "",
        (intel.fit_assessment?.red_flags ?? []).length ? `\nRed flags: ${intel.fit_assessment.red_flags.join("; ")}` : "",
      ].filter(Boolean).join("");
      if (notesText) updates.back_of_resume_notes = notesText;
      await supabase.from("candidates").update(updates).eq("id", call.candidate_id);
    }

    return respond({
      ok: true,
      summary: intel.summary,
      action_items: intel.action_items,
      structured: intel,
    });

  } catch (err: any) {
    console.error("[process-call-notes] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
