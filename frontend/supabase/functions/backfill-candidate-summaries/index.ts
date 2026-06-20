import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fetch Anthropic key: app_settings first (Chris's canonical store), env fallback
async function getAnthropicKey(): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "ANTHROPIC_API_KEY").maybeSingle();
  const fromDb = (data?.value ?? "").trim();
  if (fromDb) return fromDb;
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim() || null;
}

const SYSTEM_PROMPT = `You are Joe, an AI assistant for Emerald Recruiting Group, a Wall Street-focused financial services recruiting firm specializing in operations, fund accounting, product control, middle office, and internal audit placements at hedge funds, investment banks, fund administrators, and broker-dealers.

Generate a concise 2-3 sentence candidate profile that a recruiter can scan in 5 seconds. Focus on:
- Current seniority + firm type (hedge fund ops / bank middle office / etc.)
- Functional specialty and any notable product coverage
- Comp range if known (format: \"$X base / $Y total\")
- What they're looking for (if known)
- One distinctive signal

Write in natural prose, not bullets. No fluff. Direct, specific Wall Street voice. Do NOT invent details not in the source data.`;

function buildContext(c: Record<string, unknown>, callSummary: string | null, recentNotes: string[]): string {
  const parts: string[] = [];
  if (c.full_name) parts.push(`Name: ${c.full_name}`);
  if (c.current_title || c.current_company) {
    parts.push(`Current: ${c.current_title ?? "unknown role"} at ${c.current_company ?? "unknown firm"}`);
  }
  if (c.location_text) parts.push(`Location: ${c.location_text}`);
  if (c.work_authorization || c.visa_status) parts.push(`Work auth: ${c.work_authorization ?? c.visa_status}`);

  const compParts: string[] = [];
  if (c.current_base_comp) compParts.push(`current base $${(c.current_base_comp as number).toLocaleString()}`);
  if (c.current_bonus_comp) compParts.push(`bonus $${(c.current_bonus_comp as number).toLocaleString()}`);
  if (c.current_total_comp) compParts.push(`total $${(c.current_total_comp as number).toLocaleString()}`);
  if (c.target_base_comp) compParts.push(`target base $${(c.target_base_comp as number).toLocaleString()}`);
  if (c.target_total_comp) compParts.push(`target total $${(c.target_total_comp as number).toLocaleString()}`);
  if (compParts.length) parts.push(`Comp: ${compParts.join(", ")}`);

  if (c.reason_for_leaving) parts.push(`Reason for leaving: ${(c.reason_for_leaving as string).slice(0, 300)}`);
  if (c.target_roles) parts.push(`Target roles: ${c.target_roles}`);
  if (c.target_locations) parts.push(`Target locations: ${c.target_locations}`);
  if (c.back_of_resume_notes) parts.push(`Intake notes: ${(c.back_of_resume_notes as string).slice(0, 500)}`);

  if (c.skills && Array.isArray(c.skills) && c.skills.length) {
    parts.push(`Skills: ${(c.skills as string[]).slice(0, 15).join(", ")}`);
  }

  if (c.linkedin_profile_data && typeof c.linkedin_profile_data === "string") {
    try {
      const li = JSON.parse(c.linkedin_profile_data);
      if (li.headline) parts.push(`LinkedIn headline: ${li.headline}`);
      if (Array.isArray(li.work_experience) && li.work_experience.length) {
        const exp = li.work_experience.slice(0, 4)
          .map((e: Record<string, unknown>) => `${e.position ?? ""} at ${e.company ?? ""}`)
          .filter((s: string) => s.trim() !== " at ")
          .join("; ");
        if (exp) parts.push(`Work history: ${exp}`);
      }
    } catch { /* raw text */ }
  }

  if (callSummary) parts.push(`Latest call summary: ${callSummary.slice(0, 800)}`);
  if (recentNotes.length) parts.push(`Recent notes: ${recentNotes.join(" | ").slice(0, 800)}`);
  return parts.join("\n");
}

async function generateSummary(apiKey: string, context: string): Promise<{ summary: string | null; error: string | null }> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Source data:\n\n${context}\n\nWrite the candidate summary (2-3 sentences).` }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { summary: null, error: `anthropic_${resp.status}: ${errText.slice(0, 300)}` };
    }
    const data = await resp.json();
    const text = data?.content?.[0]?.text;
    if (!text || typeof text !== "string") {
      return { summary: null, error: `bad_response: ${JSON.stringify(data).slice(0, 300)}` };
    }
    return { summary: text.trim(), error: null };
  } catch (e) {
    return { summary: null, error: `exception: ${(e as Error).message}` };
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "missing ANTHROPIC_API_KEY (app_settings or env)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let batchSize = 25;
  let onlyCandidateId: string | null = null;
  let debug = false;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.batch_size === "number") batchSize = Math.min(Math.max(body.batch_size, 1), 100);
    if (typeof body.candidate_id === "string") onlyCandidateId = body.candidate_id;
    if (body.debug === true) debug = true;
  } catch { /* optional */ }

  const selectCols = "id, full_name, current_title, current_company, location_text, work_authorization, visa_status, current_base_comp, current_bonus_comp, current_total_comp, target_base_comp, target_bonus_comp, target_total_comp, reason_for_leaving, target_roles, target_locations, relocation_preference, skills, back_of_resume_notes, fun_facts, linkedin_profile_data";

  let candidates: Record<string, unknown>[] | null = null;
  let queryErr: string | null = null;

  if (onlyCandidateId) {
    const { data, error } = await supabase.from("candidates").select(selectCols).eq("id", onlyCandidateId);
    candidates = data as Record<string, unknown>[] | null;
    queryErr = error?.message ?? null;
  } else {
    const { data, error } = await supabase.from("candidates")
      .select(selectCols)
      .is("candidate_summary", null)
      .or("current_title.not.is.null,current_company.not.is.null,back_of_resume_notes.not.is.null,back_of_resume.eq.true")
      .limit(batchSize);
    candidates = data as Record<string, unknown>[] | null;
    queryErr = error?.message ?? null;
  }

  if (queryErr) {
    return new Response(JSON.stringify({ ok: false, error: queryErr }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!candidates || candidates.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: "no candidates to backfill" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  const samples: Array<{ id: string; summary: string }> = [];

  for (const c of candidates) {
    // Per-candidate guard: a transient PostgREST/network reject on any of the
    // reads/updates below must skip that one candidate, not crash the whole
    // batch with an uncaught throw (which surfaced as intermittent 500s).
    try {
      const { data: call } = await supabase.from("ai_call_notes").select("ai_summary")
        .eq("candidate_id", c.id as string).order("created_at", { ascending: false }).limit(1).maybeSingle();

      const { data: notes } = await supabase.from("notes").select("note")
        .eq("entity_type", "candidate").eq("entity_id", c.id as string)
        .order("created_at", { ascending: false }).limit(3);

      const context = buildContext(c, call?.ai_summary ?? null, (notes ?? []).map((n: { note: string }) => n.note).filter(Boolean).slice(0, 3));

      if (context.split("\n").length < 3) {
        skipped++;
        continue;
      }

      const { summary, error: genErr } = await generateSummary(apiKey, context);
      if (!summary) {
        failed++;
        errors.push({ id: c.id as string, reason: genErr ?? "unknown" });
        continue;
      }

      const { error: updateErr } = await supabase.from("candidates")
        .update({ candidate_summary: summary, updated_at: new Date().toISOString() })
        .eq("id", c.id as string);

      if (updateErr) {
        failed++;
        errors.push({ id: c.id as string, reason: `update: ${updateErr.message}` });
      } else {
        success++;
        if (debug && samples.length < 2) samples.push({ id: c.id as string, summary });
      }
    } catch (e) {
      failed++;
      errors.push({ id: c.id as string, reason: `loop_exception: ${(e as Error).message}` });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, batch: candidates.length, success, skipped, failed, errors: errors.slice(0, 5), samples }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
