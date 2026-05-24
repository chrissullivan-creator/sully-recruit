import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback } from "../lib/ai-fallback.js";

/**
 * POST /api/settings/translate-job-spec
 *
 * Body: { spec: string, save?: boolean }
 *
 * Takes a natural-language description of the kinds of roles the firm
 * cares about ("senior engineering leaders in fintech NYC, $200k+,
 * no interns") and asks Claude to translate it to the JobSpecFilters
 * JSON shape that PDL job/search consumes. When `save=true`, also
 * persists to app_settings so the next bulk-fetch run uses it.
 *
 * Returns the parsed filter object so the Settings UI can preview
 * what will be sent to PDL.
 *
 * Auth: standard Supabase JWT.
 */

const SYSTEM_PROMPT = `
You translate a recruiting firm's natural-language description of the
roles they care about into a strict JSON filter for the People Data
Labs job_listing search API.

Output JSON ONLY, no commentary, matching this exact shape (any field
may be omitted; use empty arrays sparingly — omit instead):
{
  "title_includes": string[],   // e.g. ["software engineer", "vp engineering"]
  "title_excludes": string[],   // e.g. ["intern", "junior"]
  "seniorities": string[],      // one of: unpaid, training, entry, senior, manager, director, vp, partner, cxo, owner
  "locations": string[],        // city or region names ("new york", "san francisco bay area")
  "employment_types": string[], // one of: full_time, part_time, contractor, temporary, internship
  "industries": string[],       // free-text industry names
  "min_salary": number,         // base USD
  "only_remote": boolean
}

Rules:
- Be conservative. Don't add filters the operator didn't ask for.
- If they say "engineers", that's title_includes:["engineer"], NOT
  also adding seniorities or locations.
- Phrases like "senior+", "senior or above", "leadership" → expand
  seniorities to ["senior","director","vp","cxo"].
- Salary phrases like "$200k+", "200k+" → min_salary: 200000.
- "Remote-only" / "fully remote" → only_remote: true.
- "Excluding interns" / "no juniors" → title_excludes plus seniorities
  list excluding the matching levels.
- If the operator didn't specify anything for a field, omit it.
- If the input is empty or completely uninterpretable, return {} (an
  empty filter — pulls everything).
`.trim();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
  }

  const spec: string = String(req.body?.spec ?? "").trim();
  const save: boolean = Boolean(req.body?.save);
  if (spec.length > 4000) return res.status(400).json({ error: "spec too long (max 4000 chars)" });

  // Empty spec → empty filter object. No AI call needed.
  if (!spec) {
    if (save) {
      await supabase.from("app_settings").upsert([
        { key: "JOB_SPEC_NATURAL_LANGUAGE", value: "" },
        { key: "JOB_SPEC_PDL_FILTERS", value: "{}" },
        { key: "JOB_SPEC_LAST_TRANSLATED_AT", value: new Date().toISOString() },
      ], { onConflict: "key" });
    }
    return res.status(200).json({ filters: {}, saved: save });
  }

  // Load AI provider keys (same cascade as parse-resume / parse-email-signature).
  let anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.anthropic_api_key || "";
  let openaiKey = process.env.OPENAI_API_KEY || "";
  let geminiKey = process.env.GEMINI_API_KEY || "";
  let openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (!anthropicKey || !openaiKey || !geminiKey || !openRouterKey) {
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
    for (const row of data ?? []) {
      if (row.key === "ANTHROPIC_API_KEY" && !anthropicKey) anthropicKey = row.value;
      if (row.key === "OPENAI_API_KEY" && !openaiKey) openaiKey = row.value;
      if (row.key === "GEMINI_API_KEY" && !geminiKey) geminiKey = row.value;
      if (row.key === "OPENROUTER_API_KEY" && !openRouterKey) openRouterKey = row.value;
    }
  }
  if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
    return res.status(500).json({
      error: "No AI provider configured (need ANTHROPIC/OPENAI/GEMINI/OPENROUTER key)",
    });
  }

  let raw: string;
  try {
    const result = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt: SYSTEM_PROMPT,
      userContent: spec,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 600,
      jsonOutput: true,
    });
    raw = result.text;
  } catch (err: any) {
    return res.status(500).json({ error: `AI call failed: ${err?.message ?? "unknown"}` });
  }

  let parsed: any;
  try {
    // Strip a stray markdown fence if the model returned one despite jsonOutput.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    return res.status(500).json({
      error: "AI returned non-JSON",
      raw: raw.slice(0, 400),
    });
  }

  if (save) {
    const { error: upsertErr } = await supabase.from("app_settings").upsert([
      { key: "JOB_SPEC_NATURAL_LANGUAGE", value: spec },
      { key: "JOB_SPEC_PDL_FILTERS", value: JSON.stringify(parsed) },
      { key: "JOB_SPEC_LAST_TRANSLATED_AT", value: new Date().toISOString() },
    ], { onConflict: "key" });
    if (upsertErr) {
      return res.status(500).json({ error: `save failed: ${upsertErr.message}`, filters: parsed });
    }
  }

  return res.status(200).json({ filters: parsed, saved: save });
}
